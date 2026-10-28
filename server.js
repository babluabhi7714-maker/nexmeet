const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: { origin: true, credentials: true }
});
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

const frontendCandidates = [
	path.join(__dirname, 'frontend'),
	path.join(process.cwd(), 'frontend'),
	path.resolve(__dirname, '..', 'frontend'),
	path.resolve(process.cwd(), '..', 'frontend'),
	__dirname
];
const frontendPath = frontendCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html')));
if (!frontendPath) throw new Error('Could not locate the frontend index.html. Set the Render root directory to the repository root.');
app.use(express.static(frontendPath));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
const inviteAttempts = new Map();
const inviteWindowMs = 10 * 60 * 1000;
function escapeHtml(value) {
	return value.replace(/[&<>\"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[character]);
}
app.post('/api/invite', async (req, res) => {
	let requestOrigin;
	try {
		requestOrigin = new URL(req.get('origin'));
	} catch {
		return res.status(403).json({ error: 'Invalid request origin.' });
	}
	if (requestOrigin.host !== req.get('host') || !['https:', 'http:'].includes(requestOrigin.protocol)) {
		return res.status(403).json({ error: 'Invalid request origin.' });
	}
	const email = String(req.body?.email || '').trim();
	const roomId = String(req.body?.roomId || '').trim().slice(0, 80);
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return res.status(400).json({ error: 'Enter a valid email address.' });
	}
	if (!roomId) return res.status(400).json({ error: 'The meeting room is missing.' });
	const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
	const resendFromEmail = String(process.env.RESEND_FROM_EMAIL || '').trim();
	if (!resendApiKey || !resendFromEmail) {
		return res.status(503).json({ error: 'Email delivery is not configured yet. Add the Resend API key and verified sender in Render.' });
	}
	const now = Date.now();
	for (const [address, timestamps] of inviteAttempts) {
		const recent = timestamps.filter((timestamp) => now - timestamp < inviteWindowMs);
		if (recent.length) inviteAttempts.set(address, recent);
		else inviteAttempts.delete(address);
	}
	const clientAddress = req.ip || req.socket.remoteAddress || 'unknown';
	const recentAttempts = inviteAttempts.get(clientAddress) || [];
	if (recentAttempts.length >= 5) return res.status(429).json({ error: 'Too many invites sent. Please try again later.' });
	inviteAttempts.set(clientAddress, [...recentAttempts, now]);
	const meetingUrl = new URL(`/?room=${encodeURIComponent(roomId)}`, requestOrigin.origin).toString();
	const safeRoomId = escapeHtml(roomId);
	const safeMeetingUrl = escapeHtml(meetingUrl);
	try {
		const providerResponse = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${resendApiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: resendFromEmail,
				to: [email],
				subject: `Invitation to ${roomId.replace(/[\r\n]+/g, ' ')}`,
				text: `You are invited to ${roomId}. Join the meeting: ${meetingUrl}`,
				html: `<p>You are invited to <strong>${safeRoomId}</strong>.</p><p><a href="${safeMeetingUrl}">Join the meeting</a></p>`,
			}),
		});
		if (!providerResponse.ok) {
			console.error(`[email-invite] Resend rejected request with status ${providerResponse.status}.`);
			return res.status(502).json({ error: 'Resend could not send the invite. Check the API key and verified sender.' });
		}
		return res.json({ sent: true });
	} catch (error) {
		console.error('[email-invite] Resend request failed.', error.message);
		return res.status(502).json({ error: 'Email delivery failed. Check the Resend configuration and try again.' });
	}
});
app.get('/api/ice-servers', (req, res) => {
	const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
	if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
		iceServers.push({
			urls: process.env.TURN_URL.split(',').map((url) => url.trim()),
			username: process.env.TURN_USERNAME,
			credential: process.env.TURN_CREDENTIAL
		});
	}
	res.json({ iceServers });
});
app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
app.use((req, res, next) => {
	if (req.method === 'GET' && !path.extname(req.path)) {
		return res.sendFile(path.join(frontendPath, 'index.html'));
	}
	next();
});

const rooms = new Map();
const waitingQueues = new Map();
const roomSettings = new Map();
const reconnectSessions = new Map();
const activePresentations = new Map();

function getReconnectSessionKey(roomId, token) {
	return `${roomId}\0${token}`;
}

function clearReconnectSession(key) {
	const session = reconnectSessions.get(key);
	if (session) clearTimeout(session.timeout);
	reconnectSessions.delete(key);
}

function syncActivePresentation(roomId, targetId) {
	const presenterId = activePresentations.get(roomId);
	const presenter = rooms.get(roomId)?.get(presenterId);
	if (presenterId && presenter) {
		io.to(targetId).emit('presentation-started', { id: presenterId, name: presenter.name || 'A participant' });
	}
}

io.on('connection', (socket) => {
	socket.on('join-room', ({ roomId, name, email, reconnectToken }, acknowledge) => {
		const cleanRoomId = String(roomId || '').trim().slice(0, 80);
		const cleanName = String(name || 'Guest').trim().slice(0, 40) || 'Guest';
		const cleanEmail = String(email || '').trim().slice(0, 160);
		if (!cleanRoomId) {
			socket.emit('join-error', 'Enter a room name to continue.');
			return acknowledge?.({ state: 'error' });
		}

		const cleanReconnectToken = String(reconnectToken || '').slice(0, 128);
		const reconnectKey = cleanReconnectToken && getReconnectSessionKey(cleanRoomId, cleanReconnectToken);
		const reconnectSession = reconnectKey && reconnectSessions.get(reconnectKey);
		if (reconnectSession && reconnectSession.expiresAt > Date.now()) {
			clearReconnectSession(reconnectKey);
			const room = rooms.get(cleanRoomId) || new Map();
			if (!roomSettings.has(cleanRoomId)) roomSettings.set(cleanRoomId, reconnectSession.settings);
			const isHost = room.size === 0 || (reconnectSession.participant.isHost && ![...room.values()].some((participant) => participant.isHost));
			const participant = { ...reconnectSession.participant, name: cleanName, email: cleanEmail, isHost, state: 'approved' };
			room.set(socket.id, participant);
			rooms.set(cleanRoomId, room);
			socket.join(cleanRoomId);
			socket.data.roomId = cleanRoomId;
			socket.data.name = cleanName;
			socket.data.email = cleanEmail;
			socket.data.reconnectToken = cleanReconnectToken;
			socket.data.state = 'approved';
			const peers = [...room.entries()].filter(([id]) => id !== socket.id).map(([id, user]) => ({ id, ...user }));
			socket.emit('room-users', peers);
			socket.emit('host-status', isHost);
			socket.emit('waiting-queue', [...(waitingQueues.get(cleanRoomId) || new Map()).entries()].map(([id, user]) => ({ id, ...user })));
			socket.emit('room-settings', roomSettings.get(cleanRoomId));
			socket.emit('approval-granted');
			syncActivePresentation(cleanRoomId, socket.id);
			acknowledge?.({ state: 'approved', host: isHost, reconnected: true });
			socket.to(cleanRoomId).emit('user-joined', { id: socket.id, name: cleanName, email: cleanEmail });
			return;
		}

		const room = rooms.get(cleanRoomId);
		const isHost = !room || room.size === 0;

		if (isHost) {
			roomSettings.set(cleanRoomId, { quickAccess: false, chatAllowed: true, handRaiseAllowed: true, screenShareAllowed: true, audioAllowed: true, videoAllowed: true, reactionsAllowed: true });
			const newRoom = new Map();
			newRoom.set(socket.id, { name: cleanName, email: cleanEmail, handRaised: false, isHost: true, role: 'host', state: 'approved', mediaState: { audioMuted: false, videoMuted: false } });
			rooms.set(cleanRoomId, newRoom);
			socket.join(cleanRoomId);
			socket.data.roomId = cleanRoomId;
			socket.data.name = cleanName;
			socket.data.email = cleanEmail;
			socket.data.reconnectToken = cleanReconnectToken;
			socket.data.state = 'approved';
			socket.emit('room-users', []);
			socket.emit('host-status', true);
			socket.emit('waiting-queue', []);
			acknowledge?.({ state: 'approved', host: true });
		} else {
			if (roomSettings.get(cleanRoomId)?.quickAccess) {
				room.set(socket.id, { name: cleanName, email: cleanEmail, handRaised: false, isHost: false, role: 'participant', state: 'approved', mediaState: { audioMuted: false, videoMuted: false } });
				rooms.set(cleanRoomId, room);
				socket.join(cleanRoomId);
				socket.data.roomId = cleanRoomId;
				socket.data.name = cleanName;
				socket.data.email = cleanEmail;
				socket.data.reconnectToken = cleanReconnectToken;
				socket.data.state = 'approved';
				socket.emit('room-users', [...room.entries()].filter(([id]) => id !== socket.id).map(([id, participant]) => ({ id, ...participant })));
				socket.emit('approval-granted');
				syncActivePresentation(cleanRoomId, socket.id);
				acknowledge?.({ state: 'approved', host: false });
				socket.to(cleanRoomId).emit('user-joined', { id: socket.id, name: cleanName, email: cleanEmail });
				return;
			}
			const waitingQueue = waitingQueues.get(cleanRoomId) || new Map();
			waitingQueue.set(socket.id, { name: cleanName, email: cleanEmail, state: 'pending', socketId: socket.id });
			waitingQueues.set(cleanRoomId, waitingQueue);
			socket.data.roomId = cleanRoomId;
			socket.data.name = cleanName;
			socket.data.email = cleanEmail;
			socket.data.reconnectToken = cleanReconnectToken;
			socket.data.state = 'pending';
			socket.emit('waiting-room', { status: 'pending', message: 'Waiting for host to approve...' });
			const queueList = [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user }));
			io.to(cleanRoomId).emit('waiting-queue', queueList);
			acknowledge?.({ state: 'pending' });
		}
		io.to(socket.id).emit('room-settings', roomSettings.get(cleanRoomId));
	});

	socket.on('host-action', ({ action, target, settings }) => {
		const room = rooms.get(socket.data.roomId);
		const host = room?.get(socket.id);
		if (!room || !host?.isHost) return;
		if (action === 'update-settings') {
			const nextSettings = {
				quickAccess: Boolean(settings?.quickAccess),
				chatAllowed: Boolean(settings?.chatAllowed),
				handRaiseAllowed: Boolean(settings?.handRaiseAllowed),
				screenShareAllowed: Boolean(settings?.screenShareAllowed),
				audioAllowed: Boolean(settings?.audioAllowed),
				videoAllowed: Boolean(settings?.videoAllowed),
				reactionsAllowed: Boolean(settings?.reactionsAllowed),
			};
			roomSettings.set(socket.data.roomId, nextSettings);
			io.to(socket.data.roomId).emit('room-settings', nextSettings);
			return;
		}
		if (!target) return;

		if (action === 'approve') {
			const waitingQueue = waitingQueues.get(socket.data.roomId);
			const pendingUser = waitingQueue?.get(target);
			if (pendingUser) {
				waitingQueue.delete(target);
				room.set(target, { name: pendingUser.name, email: pendingUser.email, handRaised: false, isHost: false, role: 'participant', state: 'approved', mediaState: { audioMuted: false, videoMuted: false } });
				rooms.set(socket.data.roomId, room);
				const approvedSocket = io.sockets.sockets.get(target);
				if (!approvedSocket) return;
				approvedSocket.join(socket.data.roomId);
				approvedSocket.data.state = 'approved';
				io.to(target).emit('approval-granted');
				const peers = [...room.entries()].filter(([id]) => id !== target).map(([id, p]) => ({ id, ...p }));
				io.to(target).emit('room-users', peers);
				syncActivePresentation(socket.data.roomId, target);
				const queueList = [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user }));
				io.to(socket.data.roomId).emit('waiting-queue', queueList);
				approvedSocket.to(socket.data.roomId).emit('user-joined', { id: target, name: pendingUser.name, email: pendingUser.email });
			}
		} else if (action === 'reject') {
			const waitingQueue = waitingQueues.get(socket.data.roomId);
			if (waitingQueue?.has(target)) {
				waitingQueue.delete(target);
				io.to(target).emit('approval-rejected');
				io.sockets.sockets.get(target)?.disconnect(true);
				const queueList = [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user }));
				io.to(socket.data.roomId).emit('waiting-queue', queueList);
			}
		} else if (action === 'remove') {
			if (!room.has(target) || target === socket.id) return;
			io.to(target).emit('removed-by-host');
			io.sockets.sockets.get(target)?.leave(socket.data.roomId);
			io.sockets.sockets.get(target)?.disconnect(true);
			room.delete(target);
			io.to(socket.data.roomId).emit('user-left', target);
		} else if (action === 'mute') {
			if (room.has(target)) io.to(target).emit('mute-request');
		} else if (action === 'give-presenter') {
			if (room.has(target)) {
				const participant = room.get(target);
				participant.role = participant.role === 'presenter' ? 'participant' : 'presenter';
				io.to(socket.data.roomId).emit('participant-role-changed', { id: target, role: participant.role });
			}
		}
	});

	socket.on('media-state', ({ audioMuted, videoMuted }) => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		const participant = room?.get(socket.id);
		if (!roomId || !participant) return;
		const settings = roomSettings.get(roomId);
		if (!participant.isHost && !settings?.audioAllowed && audioMuted === false) return socket.emit('permission-denied', 'The host has disabled microphones.');
		if (!participant.isHost && !settings?.videoAllowed && videoMuted === false) return socket.emit('permission-denied', 'The host has disabled cameras.');
		participant.mediaState = { audioMuted: Boolean(audioMuted), videoMuted: Boolean(videoMuted) };
		io.to(roomId).emit('participant-media-state', { id: socket.id, audioMuted: Boolean(audioMuted), videoMuted: Boolean(videoMuted) });
	});

	socket.on('reaction', (emoji) => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		if (!room?.has(socket.id)) return;
		if (roomSettings.get(roomId)?.reactionsAllowed === false) return socket.emit('permission-denied', 'The host has disabled reactions.');
		io.to(roomId).emit('reaction', { id: socket.id, name: socket.data.name || 'Someone', reaction: String(emoji || '').slice(0, 8) });
	});

	socket.on('control-request', ({ target }) => {
		const room = rooms.get(socket.data.roomId);
		const requester = room?.get(socket.id);
		const targetParticipant = room?.get(target);
		if (!room || !requester || !targetParticipant || target === socket.id || (!targetParticipant.isHost && targetParticipant.role !== 'presenter')) return;
		io.to(target).emit('control-request', { id: socket.id, name: requester.name || 'A participant' });
	});

	socket.on('control-response', ({ requester, approved }) => {
		const room = rooms.get(socket.data.roomId);
		const presenter = room?.get(socket.id);
		if (!room || !presenter || (!presenter.isHost && presenter.role !== 'presenter') || !room.has(requester)) return;
		io.to(requester).emit('control-response', { approved: Boolean(approved), name: presenter.name || 'Presenter' });
	});

	socket.on('signal', ({ target, signal }) => {
		if (target && signal) io.to(target).emit('signal', { sender: socket.id, signal });
	});

	socket.on('presentation-start', () => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		if (!room?.has(socket.id)) return;
		const currentPresenterId = activePresentations.get(roomId);
		if (currentPresenterId && currentPresenterId !== socket.id) {
			return socket.emit('presentation-denied', { name: room.get(currentPresenterId)?.name || 'Another participant' });
		}
		activePresentations.set(roomId, socket.id);
		io.to(roomId).emit('presentation-started', { id: socket.id, name: socket.data.name || 'A participant' });
	});

	socket.on('presentation-stop', () => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		if (!room?.has(socket.id) || activePresentations.get(roomId) !== socket.id) return;
		activePresentations.delete(roomId);
		io.to(roomId).emit('presentation-stopped', { id: socket.id });
	});

	socket.on('chat-message', (text) => {
		const roomId = socket.data.roomId;
		if (!roomId || typeof text !== 'string') return;
		if (roomSettings.get(roomId)?.chatAllowed === false) return socket.emit('permission-denied', 'The host has disabled chat.');
		const message = text.trim().slice(0, 1000);
		if (!message) return;
		io.to(roomId).emit('chat-message', { id: socket.id, name: socket.data.name || 'Guest', text: message, timestamp: Date.now() });
	});

	socket.on('caption', ({ text, active } = {}) => {
		const roomId = socket.data.roomId;
		const participant = rooms.get(roomId)?.get(socket.id);
		if (!participant || typeof text !== 'string') return;
		socket.to(roomId).emit('caption', {
			id: socket.id,
			name: participant.name || 'Guest',
			text: text.slice(0, 500),
			active: Boolean(active),
		});
	});

	socket.on('report-problem', (text) => {
		const report = typeof text === 'string' ? text.trim().slice(0, 500) : '';
		const room = rooms.get(socket.data.roomId);
		const sender = room?.get(socket.id);
		if (!report || !sender) return;
		console.warn(`[meeting-report] room=${socket.data.roomId} user=${socket.data.name || 'Guest'}: ${report}`);
		const host = [...room.entries()].find(([, participant]) => participant.isHost);
		if (host && host[0] !== socket.id) {
			io.to(host[0]).emit('report-received', { name: sender.name, text: report, timestamp: Date.now() });
		}
		socket.emit('report-submitted');
	});

	socket.on('hand-raise', (raised) => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		if (!room || !room.has(socket.id)) return;
		if (roomSettings.get(roomId)?.handRaiseAllowed === false) return socket.emit('permission-denied', 'The host has disabled hand raising.');
		const handIsRaised = Boolean(raised);
		room.get(socket.id).handRaised = handIsRaised;
		io.to(roomId).emit('hand-raise', { id: socket.id, raised: handIsRaised });
		const host = [...room.entries()].find(([, participant]) => participant.isHost);
		if (host) io.to(host[0]).emit('hand-raised-notification', { id: socket.id, name: socket.data.name || 'Guest', raised: handIsRaised });
	});

	socket.on('ice-restart', ({ target }) => {
		if (target && socket.data.roomId) io.to(target).emit('ice-restart-required', { from: socket.id });
	});

	socket.on('recording-start', () => {
		const room = rooms.get(socket.data.roomId);
		const host = room?.get(socket.id);
		if (host?.isHost) io.to(socket.data.roomId).emit('recording-started', { name: host.name || 'The host', timestamp: Date.now() });
	});

	socket.on('recording-stop', () => {
		const room = rooms.get(socket.data.roomId);
		const host = room?.get(socket.id);
		if (host?.isHost) io.to(socket.data.roomId).emit('recording-stopped', { name: host.name || 'The host', timestamp: Date.now() });
	});

	socket.on('file-share-request', ({ to, filename, size }) => io.to(to).emit('file-share-pending', { from: socket.id, fromName: socket.data.name, filename, size }));
	socket.on('file-share-approve', ({ from, filename }) => io.to(from).emit('file-share-approved', { to: socket.id, filename }));
	socket.on('file-share-deny', ({ from, filename }) => io.to(from).emit('file-share-denied', { to: socket.id, filename }));
	socket.on('file-chunk', ({ to, filename, chunk, chunkIndex, totalChunks }) => io.to(to).emit('file-chunk', { from: socket.id, filename, chunk, chunkIndex, totalChunks }));

	socket.on('disconnect', () => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		const waitingQueue = waitingQueues.get(roomId);
		if (waitingQueue?.has(socket.id)) {
			waitingQueue.delete(socket.id);
			io.to(roomId).emit('waiting-queue', [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user })));
			return;
		}
		if (!room?.has(socket.id)) return;
		const wasHost = room.get(socket.id)?.isHost;
		const participant = room.get(socket.id);
		if (activePresentations.get(roomId) === socket.id) {
			activePresentations.delete(roomId);
			io.to(roomId).emit('presentation-stopped', { id: socket.id });
		}
		if (participant && socket.data.reconnectToken) {
			const reconnectKey = getReconnectSessionKey(roomId, socket.data.reconnectToken);
			clearReconnectSession(reconnectKey);
			const session = {
				participant: { ...participant },
				settings: roomSettings.get(roomId) || { quickAccess: false, chatAllowed: true, handRaiseAllowed: true, screenShareAllowed: true, audioAllowed: true, videoAllowed: true, reactionsAllowed: true },
				expiresAt: Date.now() + 90000,
				timeout: null
			};
			session.timeout = setTimeout(() => reconnectSessions.delete(reconnectKey), 90000);
			reconnectSessions.set(reconnectKey, session);
		}
		room.delete(socket.id);
		if (wasHost && room.size > 0) {
			const [newHostId, newHost] = room.entries().next().value;
			newHost.isHost = true;
			newHost.role = 'host';
			io.to(newHostId).emit('host-status', true);
			io.to(roomId).emit('host-changed', newHostId);
		}
		socket.to(roomId).emit('user-left', socket.id);
		if (room.size === 0) {
			rooms.delete(roomId);
			waitingQueues.delete(roomId);
			roomSettings.delete(roomId);
			activePresentations.delete(roomId);
		}
	});
});

const port = Number(process.env.PORT) || 5000;
server.listen(port, '0.0.0.0', () => console.log(`Video meeting server running on port ${port}`));
