const socket = io();
const peers = new Map();
let localStream;
let screenStream;
let currentRoom;
let displayName;
let emailAddress;
let handRaised = false;
let localTileId;
let isHost = false;
let isPresenter = false;
let recorder;
let recordingChunks = [];
const participants = new Map();
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let pendingQueue = [];
let preferredAudioInputId = null;
let preferredAudioOutputId = null;
let currentConnectionState = 'new';
let iceRestartInProgress = false;
let isHeadphonesConnected = false;
let cameraFacingMode = 'user';
const raisedHandNotifications = new Map();
let recordingStartedAt = 0;
let recordingTimer;
let roomSettings = { quickAccess: false, chatAllowed: true, handRaiseAllowed: true, screenShareAllowed: true, audioAllowed: true, videoAllowed: true, reactionsAllowed: true };

const $ = (id) => document.getElementById(id);
const joinScreen = $('join-screen');
const meetingScreen = $('meeting-screen');
const waitingScreen = $('waiting-screen');
const videoGrid = $('video-grid');

function addVideo(id, name, stream, local = false) {
	let tile = document.getElementById(`tile-${id}`);
	if (!tile) {
		tile = document.createElement('article');
		tile.className = `video-tile${local ? ' local-tile' : ''}`;
		tile.id = `tile-${id}`;
		tile.innerHTML = `<video autoplay playsinline></video><div class="video-overlay"><div class="avatar-overlay"><span class="avatar-letter"></span><span class="avatar-name"></span></div><div class="mute-badge">🔇</div></div><span class="hand-indicator" aria-label="Hand raised">&#9995;</span><div class="tile-footer"><span class="avatar">${name.charAt(0).toUpperCase()}</span><span class="tile-name"></span></div>`;
		tile.querySelector('.avatar-letter').textContent = name.charAt(0).toUpperCase();
		tile.querySelector('.avatar-name').textContent = local ? `${name} (You)` : name;
		tile.querySelector('.tile-name').textContent = local ? `${name} (You)` : name;
		videoGrid.appendChild(tile);
	}
	const video = tile.querySelector('video');
	video.muted = local;
	video.autoplay = true;
	video.playsInline = true;
	video.setAttribute('playsinline', '');
	video.setAttribute('autoplay', '');
	video.srcObject = stream;
	applyAudioOutputPreference(video);
	const playPreview = () => video.play().catch(() => {
		if (!local) showMeetingError('Click anywhere in the meeting to enable participant audio.');
	});
	video.onloadedmetadata = playPreview;
	playPreview();
	updateBadges(id);
	updateCount();
}

function updateBadges(id) {
	const tile = document.getElementById(`tile-${id}`);
	if (!tile) return;
	const participant = participants.get(id);
	const avatarOverlay = tile.querySelector('.avatar-overlay');
	const muteBadge = tile.querySelector('.mute-badge');
	if (!avatarOverlay || !muteBadge) return;
	
	// Show avatar overlay if video is muted
	if (participant?.mediaState?.videoMuted) {
		tile.querySelector('video').style.display = 'none';
		avatarOverlay.classList.add('visible');
	} else {
		tile.querySelector('video').style.display = 'block';
		avatarOverlay.classList.remove('visible');
	}
	
	// Show mute badge if audio is muted
	if (participant?.mediaState?.audioMuted) {
		muteBadge.classList.add('visible');
	} else {
		muteBadge.classList.remove('visible');
	}
}

function publishMediaState() {
	const audioMuted = localStream?.getAudioTracks()[0]?.enabled === false;
	const videoMuted = localStream?.getVideoTracks()[0]?.enabled === false;
	const participant = participants.get(socket.id);
	if (participant) participant.mediaState = { audioMuted, videoMuted };
	updateBadges(localTileId || socket.id);
	renderParticipants();
	socket.emit('media-state', { audioMuted, videoMuted });
}

function updateCount() { $('participant-count').textContent = videoGrid.children.length; }

function showMeetingToast(message, type = 'info') {
	const stack = $('meeting-notifications');
	if (!stack) return;
	const toast = document.createElement('div');
	toast.className = `meeting-toast ${type}`;
	toast.textContent = message;
	stack.appendChild(toast);
	window.setTimeout(() => toast.remove(), 5000);
}

function updateRaisedHandNotification(id, name, raised) {
	const stack = $('meeting-notifications');
	if (!stack) return;
	const existing = raisedHandNotifications.get(id);
	if (!raised) {
		existing?.remove();
		raisedHandNotifications.delete(id);
		return;
	}
	if (existing) return;
	const notification = document.createElement('div');
	notification.className = 'meeting-toast hand persistent-hand-toast';
	notification.dataset.participantId = id;
	notification.textContent = `✋ ${name || 'A participant'} raised their hand`;
	stack.appendChild(notification);
	raisedHandNotifications.set(id, notification);
}

function createRoomCode() {
	return `gather-${Math.random().toString(36).slice(2, 8)}`;
}

function meetingLink(room = currentRoom) {
	return `${window.location.origin}/?room=${encodeURIComponent(room)}`;
}

function calendarDate(value) {
	return value.replace(/[-:]/g, '').replace(/\.\d{3}/, '') + '00';
}

function renderParticipants() {
	const list = $('participant-list');
	list.replaceChildren();
	for (const [id, participant] of participants) {
		const row = document.createElement('div');
		row.className = 'participant-row';
		const label = document.createElement('span');
		const muteStatus = participant.mediaState?.audioMuted ? ' · 🔇' : '';
		const videoStatus = participant.mediaState?.videoMuted ? ' · 📹' : '';
		label.textContent = `${participant.name}${id === socket.id ? ' (You)' : ''}${participant.email ? ` · ${participant.email}` : ''}${participant.isHost ? ' · Host' : ''}${participant.role === 'presenter' ? ' · Presenter' : ''}${muteStatus}${videoStatus}`;
		row.appendChild(label);
		if (id !== socket.id && participant.role === 'presenter') {
			const requestControl = document.createElement('button');
			requestControl.type = 'button';
			requestControl.textContent = 'Request control';
			requestControl.title = 'Ask this presenter for permission to control the shared screen';
			requestControl.addEventListener('click', () => {
				socket.emit('control-request', { target: id });
				showMeetingToast(`Control request sent to ${participant.name}.`, 'info');
			});
			row.appendChild(requestControl);
		}
		if (isHost && id !== socket.id && !participant.isHost) {
			const actions = document.createElement('span');
			const mute = document.createElement('button');
			mute.type = 'button';
			mute.textContent = participant.mediaState?.audioMuted ? 'Unmute' : 'Mute';
			mute.addEventListener('click', () => socket.emit('host-action', { action: 'mute', target: id }));
			const presenter = document.createElement('button');
			presenter.type = 'button'; presenter.textContent = participant.role === 'presenter' ? 'Revoke Presenter' : 'Make Presenter';
			presenter.title = 'Allow this participant to share their screen';
			presenter.addEventListener('click', () => socket.emit('host-action', { action: 'give-presenter', target: id }));
			const remove = document.createElement('button');
			remove.type = 'button'; remove.textContent = 'Remove';
			remove.addEventListener('click', () => socket.emit('host-action', { action: 'remove', target: id }));
			actions.append(mute, presenter, remove); row.appendChild(actions);
		}
		list.appendChild(row);
	}
}

function renderWaitingQueue(queue) {
	const queueDiv = $('waiting-queue');
	const pendingUsersDiv = $('pending-users');
	pendingQueue = Array.isArray(queue) ? queue : [];
	
	if (pendingQueue.length === 0 || !isHost) {
		queueDiv.classList.add('hidden');
		return;
	}
	
	queueDiv.classList.remove('hidden');
	pendingUsersDiv.replaceChildren();
	
	for (const user of pendingQueue) {
		const row = document.createElement('div');
		row.className = 'pending-user';
		row.innerHTML = `<span>${user.name}</span>`;
		const actions = document.createElement('div');
		actions.className = 'pending-user-actions';
		const approve = document.createElement('button');
		approve.className = 'approve';
		approve.textContent = 'Approve';
		approve.addEventListener('click', () => socket.emit('host-action', { action: 'approve', target: user.id }));
		const reject = document.createElement('button');
		reject.className = 'reject';
		reject.textContent = 'Reject';
		reject.addEventListener('click', () => socket.emit('host-action', { action: 'reject', target: user.id }));
		actions.append(approve, reject);
		row.appendChild(actions);
		pendingUsersDiv.appendChild(row);
	}
}

function renderRoomSettings(settings = {}) {
	roomSettings = { ...roomSettings, ...settings };
	const controls = {
		'quick-access-toggle': roomSettings.quickAccess,
		'chat-permission-toggle': roomSettings.chatAllowed,
		'hand-permission-toggle': roomSettings.handRaiseAllowed,
		'share-permission-toggle': roomSettings.screenShareAllowed,
		'audio-permission-toggle': roomSettings.audioAllowed,
		'video-permission-toggle': roomSettings.videoAllowed,
		'reaction-permission-toggle': roomSettings.reactionsAllowed,
	};
	for (const [id, value] of Object.entries(controls)) {
		const input = $(id);
		if (input) input.checked = Boolean(value);
	}
}

async function createPeer(id, name, initiator) {
	if (peers.has(id)) return peers.get(id).connection;
	const connection = new RTCPeerConnection({ iceServers });
	peers.set(id, { connection, name });
	localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));
	connection.onicecandidate = ({ candidate }) => candidate && socket.emit('signal', { target: id, signal: { candidate } });
	connection.ontrack = ({ streams }) => addVideo(id, name, streams[0]);
	connection.onconnectionstatechange = () => {
		if (connection.connectionState === 'failed') {
			if (!iceRestartInProgress) {
				iceRestartInProgress = true;
				connection.restartIce();
				setTimeout(() => { iceRestartInProgress = false; }, 2000);
			}
		} else if (['closed', 'disconnected'].includes(connection.connectionState)) {
			removePeer(id);
		}
	};
	connection.oniceconnectionstatechange = () => {
		currentConnectionState = connection.iceConnectionState;
		if (connection.iceConnectionState === 'disconnected' || connection.iceConnectionState === 'failed') {
			if (!iceRestartInProgress && connection.iceConnectionState === 'failed') {
				iceRestartInProgress = true;
				connection.restartIce();
				setTimeout(() => { iceRestartInProgress = false; }, 2000);
			}
		}
	};
	if (initiator) {
		const offer = await connection.createOffer();
		await connection.setLocalDescription(offer);
		socket.emit('signal', { target: id, signal: { description: connection.localDescription } });
	}
	return connection;
}

function removePeer(id) {
	const peer = peers.get(id);
	if (peer) peer.connection.close();
	peers.delete(id);
	document.getElementById(`tile-${id}`)?.remove();
	updateCount();
}

async function detectPreferredAudioDevices() {
	if (!navigator.mediaDevices?.enumerateDevices) return;
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const outputDevices = devices.filter((device) => device.kind === 'audiooutput');
		const inputDevices = devices.filter((device) => device.kind === 'audioinput');
		const match = (deviceList, keywords) => deviceList.find((device) => {
			const label = (device.label || '').toLowerCase();
			return keywords.some((keyword) => label.includes(keyword));
		}) || deviceList[0];

		const preferredOutput = match(outputDevices, ['headphone', 'headset', 'usb', 'bluetooth', 'airpods']);
		if (preferredOutput) preferredAudioOutputId = preferredOutput.deviceId;

		const preferredInput = match(inputDevices, ['headphone', 'headset', 'usb', 'bluetooth', 'microphone']);
		if (preferredInput) preferredAudioInputId = preferredInput.deviceId;
		
		updateHeadphoneStatus(outputDevices);
	} catch {
		preferredAudioInputId = null;
		preferredAudioOutputId = null;
	}
}

function updateHeadphoneStatus(outputDevices) {
	const headphoneDevices = outputDevices.filter((device) => {
		const label = (device.label || '').toLowerCase();
		return label.includes('headphone') || label.includes('headset') || label.includes('airpods') || label.includes('earphone');
	});
	
	isHeadphonesConnected = headphoneDevices.length > 0;
	const statusDiv = $('audio-device-status');
	
	if (isHeadphonesConnected) {
		statusDiv.classList.remove('hidden');
		const firstHeadphone = headphoneDevices[0];
		let deviceName = 'Headphones';
		if (firstHeadphone.label.toLowerCase().includes('airpods')) deviceName = 'AirPods';
		else if (firstHeadphone.label.toLowerCase().includes('usb')) deviceName = 'USB Headset';
		else if (firstHeadphone.label.toLowerCase().includes('bluetooth')) deviceName = 'Bluetooth';
		$('audio-device-label').textContent = deviceName;
	} else {
		statusDiv.classList.add('hidden');
	}
}

async function monitorAudioDevices() {
	if (!navigator.mediaDevices?.addEventListener) return;
	try {
		navigator.mediaDevices.addEventListener('devicechange', async () => {
			await detectPreferredAudioDevices();
		});
	} catch {
		// Fallback: check devices periodically
		setInterval(async () => {
			await detectPreferredAudioDevices();
		}, 3000);
	}
}

function applyAudioOutputPreference(video) {
	if (typeof video.setSinkId === 'function' && preferredAudioOutputId) {
		video.setSinkId(preferredAudioOutputId).catch(() => {});
	}
}

async function startMeeting(event) {
	event.preventDefault();
	$('join-error').textContent = '';
	displayName = $('name').value.trim() || 'Guest';
	emailAddress = $('email').value.trim().toLowerCase();
	if (!emailAddress) return $('join-error').textContent = 'Enter your email address.';
	updateNameBadge(displayName);
	const roomValue = $('room').value.trim();
	try { currentRoom = new URL(roomValue).searchParams.get('room') || roomValue; } catch { currentRoom = roomValue; }
	currentRoom = currentRoom.trim();
	if (!currentRoom) return $('join-error').textContent = 'Enter a meeting code or link.';
	try {
		try {
			const response = await fetch('/api/ice-servers');
			if (response.ok) ({ iceServers } = await response.json());
		} catch { /* Keep the public STUN server as a fallback. */ }
		await detectPreferredAudioDevices();
		monitorAudioDevices();
		const audioConstraints = {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		};
		if (preferredAudioInputId) audioConstraints.deviceId = { exact: preferredAudioInputId };
		const videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
		try {
			localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
		} catch (error) {
			if (error.name !== 'OverconstrainedError') throw error;
			localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
		}
		localTileId = socket.id || 'local';
		participants.set(socket.id, { name: displayName, email: emailAddress, isHost: false, role: 'participant', mediaState: { audioMuted: false, videoMuted: false } });
		addVideo(localTileId, displayName, localStream, true);
		$('room-title').textContent = currentRoom;
		$('copy-link-button').title = meetingLink();
		joinScreen.classList.add('hidden');
		meetingScreen.classList.add('hidden');
		waitingScreen.classList.add('hidden');
		document.body.classList.add('in-meeting');
		socket.emit('join-room', { roomId: currentRoom, name: displayName, email: emailAddress }, ({ state, host }) => {
			if (state === 'pending') {
				joinScreen.classList.add('hidden');
				meetingScreen.classList.add('hidden');
				waitingScreen.classList.remove('hidden');
			} else if (state === 'approved' && host) {
				waitingScreen.classList.add('hidden');
				meetingScreen.classList.remove('hidden');
			}
		});
	} catch (error) {
		const messages = {
			NotAllowedError: 'Allow camera and microphone access in your phone browser settings, then try again.',
			NotFoundError: 'No camera or microphone was found on this device.',
			NotReadableError: 'Your camera is being used by another app. Close it and try again.',
			SecurityError: 'Camera access requires the secure HTTPS meeting link.',
		};
		$('join-error').textContent = messages[error.name] || 'Could not access your camera. Check your phone permissions and try again.';
	}
}

socket.on('room-users', async (users) => {
	for (const user of users) { 
		if (!user.mediaState) user.mediaState = { audioMuted: false, videoMuted: false };
		participants.set(user.id, user);
		await createPeer(user.id, user.name, true);
	}
	renderParticipants();
});
socket.on('user-joined', ({ id, name, email }) => { participants.set(id, { name, email, isHost: false, role: 'participant', mediaState: { audioMuted: false, videoMuted: false } }); renderParticipants(); return createPeer(id, name, false); });
socket.on('signal', async ({ sender, signal }) => {
	const peer = peers.get(sender) || { connection: await createPeer(sender, 'Guest', false) };
	const connection = peer.connection;
	if (signal.description) {
		await connection.setRemoteDescription(signal.description);
		if (signal.description.type === 'offer') {
			const answer = await connection.createAnswer();
			await connection.setLocalDescription(answer);
			socket.emit('signal', { target: sender, signal: { description: connection.localDescription } });
		}
	} else if (signal.candidate) await connection.addIceCandidate(signal.candidate).catch(() => {});
});
socket.on('user-left', (id) => { participants.delete(id); renderParticipants(); removePeer(id); });
socket.on('join-error', (message) => { $('join-error').textContent = message; });
	socket.on('waiting-room', () => {
	joinScreen.classList.add('hidden');
	meetingScreen.classList.add('hidden');
	waitingScreen.classList.remove('hidden');
});
function syncMeetingControls() {
	const visibleControls = [
		$('camera-button'),
		$('mic-button'),
		$('reaction-button'),
		$('more-button'),
		$('leave-button'),
		$('switch-camera-button'),
		$('hand-button'),
		$('captions-button'),
		$('share-button'),
		$('chat-button'),
		$('people-button'),
		$('activities-button'),
		$('file-button'),
		$('record-button'),
		$('fullscreenBtn'),
		$('top-share-button'),
	];
	visibleControls.forEach((button) => button && button.classList.remove('hidden'));
	$('meeting-id-detail') && ($('meeting-id-detail').textContent = currentRoom || 'Meeting');
}

socket.on('approval-granted', () => {
	waitingScreen.classList.add('hidden');
	meetingScreen.classList.remove('hidden');
	syncMeetingControls();
});
socket.on('approval-rejected', () => {
	waitingScreen.classList.add('hidden');
	joinScreen.classList.remove('hidden');
	$('join-error').textContent = 'The host declined your request to join.';
});
socket.on('waiting-queue', (queue) => {
	const previousCount = pendingQueue.length;
	renderWaitingQueue(queue);
	if (isHost && pendingQueue.length > previousCount) {
		const latest = pendingQueue[pendingQueue.length - 1];
		showMeetingToast(`${latest?.name || 'Someone'} is waiting to join`, 'waiting');
	}
});
socket.on('host-status', (host) => {
	isHost = host;
	$('record-button').classList.toggle('hidden', !host);
	renderWaitingQueue(pendingQueue);
	if (host) {
		waitingScreen.classList.add('hidden');
		meetingScreen.classList.remove('hidden');
		syncMeetingControls();
	}
	renderParticipants();
});
socket.on('room-settings', (settings) => renderRoomSettings(settings));
socket.on('permission-denied', (message) => showMeetingToast(message, 'error'));
socket.on('reaction', ({ name, emoji }) => showMeetingToast(`${name || 'Someone'} reacted ${emoji}`, 'success'));
socket.on('host-changed', (id) => { const participant = participants.get(id); if (participant) participant.isHost = true; renderParticipants(); });
socket.on('participant-role-changed', ({ id, role }) => {
	const participant = participants.get(id);
	if (participant) participant.role = role;
	if (id === socket.id) isPresenter = role === 'presenter';
	renderParticipants();
});
socket.on('participant-media-state', ({ id, audioMuted, videoMuted }) => {
	const participant = participants.get(id);
	if (participant) {
		if (!participant.mediaState) participant.mediaState = {};
		participant.mediaState.audioMuted = audioMuted;
		participant.mediaState.videoMuted = videoMuted;
		updateBadges(id);
		renderParticipants();
	}
});
socket.on('mute-request', () => {
	const track = localStream?.getAudioTracks()[0];
	if (track) {
		track.enabled = false;
		$('mic-button').classList.add('muted');
		document.querySelector('#mic-button small').textContent = 'Unmute';
		publishMediaState();
	}
});
socket.on('removed-by-host', () => { localStream?.getTracks().forEach((track) => track.stop()); showMeetingError('The host removed you from the meeting.'); window.setTimeout(() => window.location.reload(), 1500); });
socket.on('hand-raise', ({ id, raised }) => {
	document.querySelector(`#tile-${id} .hand-indicator`)?.classList.toggle('visible', raised);
});
socket.on('hand-raised-notification', ({ id, name, raised }) => {
	if (isHost && id !== socket.id) updateRaisedHandNotification(id, name, raised);
});
socket.on('chat-message', ({ id, name, text, timestamp }) => {
	const item = document.createElement('div');
	item.className = `message ${id === socket.id ? 'mine' : ''}`;
	item.innerHTML = `<div class="message-meta"><strong></strong><time></time></div><p></p>`;
	item.querySelector('strong').textContent = id === socket.id ? 'You' : name;
	item.querySelector('time').textContent = new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	item.querySelector('p').textContent = text;
	$('messages').appendChild(item);
	$('messages').scrollTop = $('messages').scrollHeight;
	if (id !== socket.id && !$('chat-panel').classList.contains('open')) showMeetingToast(`${name}: ${text}`, 'chat');
});
function updateRecordingStatus() {
	if (!recordingStartedAt) return;
	const elapsed = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
	$('recording-time').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}
function setRecordingStatus(isRecording, timestamp = Date.now()) {
	if (isRecording) {
		recordingStartedAt = timestamp;
		$('recording-status').classList.remove('hidden');
		$('record-button').classList.add('active');
		document.querySelector('#record-button small').textContent = 'Stop';
		clearInterval(recordingTimer);
		updateRecordingStatus();
		recordingTimer = window.setInterval(updateRecordingStatus, 1000);
	} else {
		recordingStartedAt = 0;
		clearInterval(recordingTimer);
		$('recording-status').classList.add('hidden');
		$('record-button').classList.remove('active');
		document.querySelector('#record-button small').textContent = 'Record';
	}
}
socket.on('recording-started', ({ timestamp }) => { setRecordingStatus(true, timestamp || Date.now()); showMeetingToast('Recording started', 'recording'); });
socket.on('recording-stopped', () => { setRecordingStatus(false); showMeetingToast('Recording stopped', 'recording'); });
socket.on('file-share-pending', ({ from, fromName, filename, size }) => {
	const fileRequests = $('file-requests');
	const item = document.createElement('div');
	item.className = 'file-item';
	item.innerHTML = `<div class="file-item-header"><strong>${fromName}</strong></div><div class="file-item-meta">${filename} (${(size / 1024 / 1024).toFixed(2)}MB)</div>`;
	const actions = document.createElement('div');
	actions.className = 'file-actions';
	const approve = document.createElement('button');
	approve.className = 'approve';
	approve.textContent = 'Accept';
	approve.addEventListener('click', () => socket.emit('file-share-approve', { from, filename }));
	const deny = document.createElement('button');
	deny.className = 'deny';
	deny.textContent = 'Decline';
	deny.addEventListener('click', () => socket.emit('file-share-deny', { from, filename }));
	actions.append(approve, deny);
	item.appendChild(actions);
	fileRequests.appendChild(item);
	$('file-button').classList.remove('hidden');
});
socket.on('file-share-approved', ({ to, filename }) => {
	showMeetingError(`${filename} approved. Sending...`);
});
socket.on('file-share-denied', ({ to, filename }) => {
	showMeetingError(`${filename} was declined.`);
});
socket.on('ice-restart-required', ({ from }) => {
	const peer = peers.get(from);
	if (peer && !iceRestartInProgress) {
		iceRestartInProgress = true;
		peer.connection.restartIce();
		setTimeout(() => { iceRestartInProgress = false; }, 2000);
	}
});

$('join-form').addEventListener('submit', startMeeting);
$('new-meeting-button').addEventListener('click', () => {
	$('room').value = createRoomCode();
	$('room').focus();
	$('join-error').textContent = 'Your new meeting is ready. Enter your name to join.';
});
$('get-link-button').addEventListener('click', async () => {
	const room = $('room').value.trim() || createRoomCode();
	$('room').value = room;
	$('invite-link').value = meetingLink(room);
	$('invite-box').classList.remove('hidden');
	try { await navigator.clipboard.writeText($('invite-link').value); $('copy-invite-button').textContent = 'Copied'; window.setTimeout(() => { $('copy-invite-button').textContent = 'Copy'; }, 1800); } catch { $('copy-invite-button').textContent = 'Copy link'; }
});
$('copy-invite-button').addEventListener('click', async () => {
	try { await navigator.clipboard.writeText($('invite-link').value); $('copy-invite-button').textContent = 'Copied'; window.setTimeout(() => { $('copy-invite-button').textContent = 'Copy'; }, 1800); } catch { $('invite-link').select(); }
});
$('schedule-button').addEventListener('click', () => {
	$('schedule-fields').classList.toggle('hidden');
	$('schedule-title').focus();
	if (!$('schedule-date').value) {
		const date = new Date(Date.now() + 60 * 60 * 1000);
		date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
		$('schedule-date').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
	}
});
$('calendar-link-button').addEventListener('click', () => {
	const title = $('schedule-title').value.trim() || 'Gather meeting';
	const start = $('schedule-date').value;
	if (!start) return $('join-error').textContent = 'Choose a date and time first.';
	const endDate = new Date(start); endDate.setHours(endDate.getHours() + 1);
	const details = `Join the Gather meeting: ${meetingLink($('room').value || createRoomCode())}`;
	const url = new URL('https://calendar.google.com/calendar/render');
	url.search = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${calendarDate(start)}/${calendarDate(endDate.toISOString().slice(0, 16))}`, details }).toString();
	window.open(url, '_blank', 'noopener');
});

$('mic-button').addEventListener('click', () => {
	if (!isHost && !roomSettings.audioAllowed) return showMeetingToast('The host has disabled microphones.', 'error');
	const track = localStream?.getAudioTracks()[0];
	if (!track) return;
	track.enabled = !track.enabled;
	$('mic-button').classList.toggle('muted', !track.enabled);
	document.querySelector('#mic-button small').textContent = track.enabled ? 'Mute' : 'Unmute';
	publishMediaState();
});
$('camera-button').addEventListener('click', () => {
	if (!isHost && !roomSettings.videoAllowed) return showMeetingToast('The host has disabled cameras.', 'error');
	const track = localStream?.getVideoTracks()[0];
	if (!track) return;
	track.enabled = !track.enabled;
	$('camera-button').classList.toggle('muted', !track.enabled);
	document.querySelector('#camera-button small').textContent = track.enabled ? 'Camera' : 'Video off';
	publishMediaState();
});
$('switch-camera-button').addEventListener('click', async () => {
	if (!localStream?.getVideoTracks().length) return showMeetingToast('Camera is not available.', 'error');
	const nextFacingMode = cameraFacingMode === 'user' ? 'environment' : 'user';
	try {
		const replacementStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: nextFacingMode } }, audio: false });
		const replacementTrack = replacementStream.getVideoTracks()[0];
		for (const { connection } of peers.values()) {
			const sender = connection.getSenders().find((item) => item.track?.kind === 'video');
			if (sender) await sender.replaceTrack(replacementTrack);
		}
		const oldTrack = localStream.getVideoTracks()[0];
		localStream.removeTrack(oldTrack);
		localStream.addTrack(replacementTrack);
		oldTrack.stop();
		cameraFacingMode = nextFacingMode;
		addVideo(localTileId, displayName, localStream, true);
		showMeetingToast(cameraFacingMode === 'user' ? 'Front camera selected.' : 'Back camera selected.');
	} catch (error) {
		showMeetingToast(error.name === 'OverconstrainedError' ? 'This device does not have that camera.' : 'Could not switch camera.', 'error');
	}
});
$('hand-button').addEventListener('click', () => { handRaised = !handRaised; $('hand-button').classList.toggle('active', handRaised); document.querySelector('#hand-button small').textContent = handRaised ? 'Lower hand' : 'Raise hand'; socket.emit('hand-raise', handRaised); });
$('share-button').addEventListener('click', async () => {
	if (!isHost && !isPresenter && !roomSettings.screenShareAllowed) return showMeetingToast('The host has disabled screen sharing.', 'error');
	if (screenStream) return stopSharing();
	const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices) || navigator.getDisplayMedia?.bind(navigator);
	if (!getDisplayMedia) return showMeetingError('This browser cannot start screen sharing. Other participants can still view a share started from a supported laptop browser.');
	try {
		screenStream = await getDisplayMedia({ video: true });
		const track = screenStream.getVideoTracks()[0];
		for (const { connection } of peers.values()) {
			const sender = connection.getSenders().find((item) => item.track?.kind === 'video');
			if (sender) await sender.replaceTrack(track);
		}
		addVideo(localTileId, displayName, screenStream, true);
		track.onended = stopSharing;
		$('share-button').classList.add('active');
		$('top-share-button')?.classList.add('active');
		document.querySelector('#share-button small').textContent = 'Stop sharing';
		$('top-share-button') && ($('top-share-button').querySelector('span').textContent = '◉');
		if (isPresenter) showMeetingToast('You are presenting to the meeting.');
	} catch (error) {
		if (error.name === 'AbortError' || error.name === 'NotAllowedError') return;
		const message = error.name === 'NotReadableError'
			? 'Your browser could not capture that screen. Close other screen-sharing sessions and try again.'
			: `Screen sharing failed (${error.name || 'browser error'}). Check the browser permission and try again.`;
		showMeetingError(message);
	}
});
function stopSharing() {
	const track = localStream?.getVideoTracks()[0];
	for (const { connection } of peers.values()) {
		const sender = connection.getSenders().find((item) => item.track?.kind === 'video');
		if (sender && track) sender.replaceTrack(track);
	}
	screenStream?.getTracks().forEach((item) => item.stop());
	screenStream = null;
	addVideo(localTileId, displayName, localStream, true);
	$('share-button').classList.remove('active');
	$('top-share-button')?.classList.remove('active');
	document.querySelector('#share-button small').textContent = 'Share screen';
	if ($('top-share-button')) $('top-share-button').querySelector('span').textContent = '◉';
	if (isPresenter && isHost) {
		isPresenter = false;
		socket.emit('participant-role-changed', { id: socket.id, role: 'participant' });
	}
}
function showMeetingError(message) {
	$('meeting-error').textContent = message;
	window.setTimeout(() => { $('meeting-error').textContent = ''; }, 5000);
}
$('chat-form').addEventListener('submit', (event) => { event.preventDefault(); const input = $('chat-input'); if (input.value.trim()) { socket.emit('chat-message', input.value); input.value = ''; } });

function setChatPanelOpen(isOpen) {
	$('chat-panel').classList.toggle('open', isOpen);
	if (isOpen) $('host-panel').classList.add('hidden');
	if (isOpen) $('file-panel').classList.add('hidden');
	if (isOpen) $('utility-panel').classList.add('hidden');
	if (isOpen) $('activity-panel').classList.add('hidden');
}

function setHostPanelOpen(isOpen) {
	$('host-panel').classList.toggle('hidden', !isOpen);
	if (isOpen) $('chat-panel').classList.remove('open');
	if (isOpen) $('file-panel').classList.add('hidden');
	if (isOpen) $('utility-panel').classList.add('hidden');
	if (isOpen) $('activity-panel').classList.add('hidden');
}

function setFilePanelOpen(isOpen) {
	$('file-panel').classList.toggle('hidden', !isOpen);
	if (isOpen) $('chat-panel').classList.remove('open');
	if (isOpen) $('host-panel').classList.add('hidden');
	if (isOpen) $('utility-panel').classList.add('hidden');
	if (isOpen) $('activity-panel').classList.add('hidden');
}

function setActivityPanelOpen(isOpen) {
	$('activity-panel').classList.toggle('hidden', !isOpen);
	if (isOpen) $('chat-panel').classList.remove('open');
	if (isOpen) $('host-panel').classList.add('hidden');
	if (isOpen) $('file-panel').classList.add('hidden');
	if (isOpen) $('utility-panel').classList.add('hidden');
}

$('chat-button').addEventListener('click', () => {
	const shouldOpen = !$('chat-panel').classList.contains('open');
	setChatPanelOpen(shouldOpen);
});
$('close-chat').addEventListener('click', () => setChatPanelOpen(false));
$('close-host').addEventListener('click', () => setHostPanelOpen(false));
$('people-button').addEventListener('click', () => setHostPanelOpen($('host-panel').classList.contains('hidden')));
$('activities-button').addEventListener('click', () => setActivityPanelOpen($('activity-panel').classList.contains('hidden')));
$('close-activities').addEventListener('click', () => setActivityPanelOpen(false));
$('profile-button').addEventListener('click', () => {
	const shouldOpen = $('host-panel').classList.contains('hidden');
	setHostPanelOpen(shouldOpen);
	$('profile-button').setAttribute('aria-expanded', String(shouldOpen));
});
$('file-button').addEventListener('click', () => {
	const shouldOpen = $('file-panel').classList.contains('hidden');
	setFilePanelOpen(shouldOpen);
});
$('close-files').addEventListener('click', () => setFilePanelOpen(false));
$('copy-link-button').addEventListener('click', async () => {
	try { await navigator.clipboard.writeText(meetingLink()); $('copy-link-button').textContent = 'Link copied'; window.setTimeout(() => { $('copy-link-button').textContent = 'Copy invite link'; }, 1800); } catch { showMeetingError(`Invite link: ${meetingLink()}`); }
});
$('record-button').addEventListener('click', () => {
	if (!isHost) return showMeetingError('Only the host can record this meeting.');
	if (recorder?.state === 'recording') return recorder.stop();
	if (!window.MediaRecorder || !localStream) return showMeetingError('Recording is not supported by this browser.');
	const videoTrack = screenStream?.getVideoTracks()[0] || localStream.getVideoTracks()[0];
	const recordStream = new MediaStream([videoTrack, ...localStream.getAudioTracks()]);
	recordingChunks = [];
	const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
	try { recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined); } catch { return showMeetingError('Recording is not supported by this browser.'); }
	recorder.ondataavailable = (event) => event.data.size && recordingChunks.push(event.data);
	recorder.onstop = () => { 
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob(recordingChunks, { type: 'video/webm' }));
		link.download = `gather-${currentRoom}-${Date.now()}.webm`;
		link.click();
		URL.revokeObjectURL(link.href);
		setRecordingStatus(false);
		socket.emit('recording-stop');
	};
	recorder.start();
	socket.emit('recording-start');
	$('record-button').classList.add('active');
	setRecordingStatus(true);
});
$('cancel-wait-button').addEventListener('click', () => { socket.disconnect(); window.location.reload(); });
$('leave-button').addEventListener('click', () => { document.body.classList.remove('in-meeting'); localStream?.getTracks().forEach((track) => track.stop()); screenStream?.getTracks().forEach((track) => track.stop()); socket.disconnect(); window.location.reload(); });

document.addEventListener('click', () => {
	videoGrid.querySelectorAll('video:not([muted])').forEach((video) => video.play().catch(() => {}));
}, { passive: true });

const roomFromUrl = new URLSearchParams(window.location.search).get('room');
if (roomFromUrl) $('room').value = roomFromUrl;
socket.on('waiting-for-approval', () => {
    const overlay = document.getElementById('waiting-overlay');
    if (overlay) overlay.style.display = 'flex';
});

socket.on('admission-granted', () => {
    const overlay = document.getElementById('waiting-overlay');
    if (overlay) overlay.style.display = 'none';
});

socket.on('admission-rejected', () => {
    alert('The host declined your request to join.');
    window.location.reload();
});

socket.on('user-waiting', ({ id, username }) => {
	if (confirm(`User "${username}" wants to join. Allow entry?`)) socket.emit('host-action', { action: 'approve', target: id });
	else socket.emit('host-action', { action: 'reject', target: id });
});

function updateNameBadge(newName) {
	const badgeText = $('displayName');
	if (badgeText && newName) badgeText.textContent = newName;
}

const fullscreenButton = $('fullscreenBtn');
fullscreenButton?.addEventListener('click', async () => {
		try {
			if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
			else await document.exitFullscreen();
		} catch { showMeetingError('Fullscreen is not available in this browser.'); }
});

const utilityPanel = $('utility-panel');
function setUtilityPanelOpen(isOpen) {
	utilityPanel.classList.toggle('hidden', !isOpen);
	if (isOpen) {
		$('chat-panel').classList.remove('open');
		$('host-panel').classList.add('hidden');
		$('file-panel').classList.add('hidden');
	}
}
$('more-button').addEventListener('click', () => setUtilityPanelOpen(utilityPanel.classList.contains('hidden')));
$('close-utility').addEventListener('click', () => setUtilityPanelOpen(false));
$('more-captions-button').addEventListener('click', () => $('captions-button').click());

$('more-audio-button').addEventListener('click', async () => {
	setUtilityPanelOpen(true);
	try {
		await Promise.all([getAudioDevices(), populateDeviceSettings()]);
		$('microphone-input-select')?.focus();
	} catch {
		showMeetingToast('Could not load your audio and video devices.', 'error');
	}
});
$('top-share-button')?.addEventListener('click', () => $('share-button').click());
$('more-chat-button').addEventListener('click', () => { setUtilityPanelOpen(false); setChatPanelOpen(true); });
$('more-settings-button').addEventListener('click', () => {
	setUtilityPanelOpen(true);
	$('settings-button')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('more-tools-button').addEventListener('click', () => {
	setUtilityPanelOpen(true);
	$('tools-activities-button')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('more-report-button').addEventListener('click', () => $('report-button').click());
$('reaction-button').addEventListener('click', () => setActivityPanelOpen(true));
$('captions-button').addEventListener('click', () => {
	const toggle = $('captions-toggle');
	toggle.checked = !toggle.checked;
	toggle.dispatchEvent(new Event('change'));
});
document.querySelectorAll('[data-reaction]').forEach((button) => button.addEventListener('click', () => {
	showMeetingToast(`${displayName || 'You'} reacted ${button.dataset.reaction}`, 'success');
	socket.emit('reaction', button.dataset.reaction);
}));
$('copy-details-button').addEventListener('click', async () => {
	const details = `Gather Meeting\nMeeting ID: ${currentRoom}\nJoin: ${meetingLink()}`;
	try { await navigator.clipboard.writeText(details); showMeetingToast('Joining information copied.', 'success'); } catch { showMeetingError(details); }
});
$('create-poll-button').addEventListener('click', () => showMeetingToast('Poll creation is ready for a future poll question.', 'info'));
$('test-microphone-button').addEventListener('click', () => {
	if (!localStream?.getAudioTracks().length) return showMeetingToast('Microphone is not available.', 'error');
	showMeetingToast('Microphone is working.', 'success');
});
$('test-speaker-button').addEventListener('click', async () => {
	const media = document.querySelector('#video-grid video');
	if (media) await media.play().catch(() => {});
	showMeetingToast('Speaker test played.', 'success');
});
$('audio-only-toggle').addEventListener('change', (event) => {
	const track = localStream?.getVideoTracks()[0];
	if (!track) return;
	track.enabled = !event.target.checked;
	showMeetingToast(event.target.checked ? 'On-the-go audio only enabled.' : 'Camera restored.', 'success');
});
$('mirror-video-toggle').addEventListener('change', (event) => {
	const video = document.querySelector(`#tile-${localTileId} video`);
	if (video) video.style.transform = event.target.checked ? 'scaleX(-1)' : 'none';
});
$('caption-size-select').addEventListener('change', (event) => {
	$('caption-display').style.fontSize = event.target.value === 'large' ? '18px' : event.target.value === 'small' ? '11px' : '14px';
});

async function getAudioDevices() {
		const select = $('audioOutputSelect');
		if (!select || !navigator.mediaDevices?.enumerateDevices) return;
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			select.replaceChildren(new Option('Default speaker', ''));
			devices.filter((device) => device.kind === 'audiooutput').forEach((device, index) => {
				select.appendChild(new Option(device.label || `Speaker ${index + 1}`, device.deviceId));
			});
		} catch { showMeetingError('Could not read your speaker devices.'); }
}
$('audioOutputSelect').addEventListener('change', async (event) => {
		const deviceId = event.target.value;
		for (const media of document.querySelectorAll('audio, video')) {
			if (typeof media.setSinkId === 'function') await media.setSinkId(deviceId).catch(() => {});
		}
		showMeetingError(deviceId ? 'Speaker changed.' : 'Using the default speaker.');
});
$('refresh-audio-button').addEventListener('click', getAudioDevices);

async function populateDeviceSettings() {
	const cameraSelect = $('camera-input-select');
	const microphoneSelect = $('microphone-input-select');
	if (!cameraSelect || !microphoneSelect || !navigator.mediaDevices?.enumerateDevices) return;
	const devices = await navigator.mediaDevices.enumerateDevices();
	cameraSelect.replaceChildren();
	microphoneSelect.replaceChildren();
	devices.filter((device) => device.kind === 'videoinput').forEach((device, index) => cameraSelect.appendChild(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
	devices.filter((device) => device.kind === 'audioinput').forEach((device, index) => microphoneSelect.appendChild(new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
	const currentVideo = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
	const currentAudio = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
	if (currentVideo) cameraSelect.value = currentVideo;
	if (currentAudio) microphoneSelect.value = currentAudio;
}
$('settings-button').addEventListener('click', async () => {
	$('device-settings').classList.toggle('hidden');
	$('settings-button').textContent = $('device-settings').classList.contains('hidden') ? 'Open device settings' : 'Close device settings';
	if (!$('device-settings').classList.contains('hidden')) {
		try { await populateDeviceSettings(); showMeetingToast('Device settings ready.'); } catch { showMeetingToast('Could not read camera and microphone devices.', 'error'); }
	}
});
$('apply-device-button').addEventListener('click', async () => {
	const videoDeviceId = $('camera-input-select').value;
	const audioDeviceId = $('microphone-input-select').value;
	try {
		const replacement = await navigator.mediaDevices.getUserMedia({
			video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
			audio: audioDeviceId ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true } : true,
		});
		const newVideo = replacement.getVideoTracks()[0];
		const newAudio = replacement.getAudioTracks()[0];
		const videoWasEnabled = localStream?.getVideoTracks()[0]?.enabled !== false;
		const audioWasEnabled = localStream?.getAudioTracks()[0]?.enabled !== false;
		if (newVideo) newVideo.enabled = videoWasEnabled;
		if (newAudio) newAudio.enabled = audioWasEnabled;
		for (const { connection } of peers.values()) {
			const videoSender = connection.getSenders().find((sender) => sender.track?.kind === 'video');
			const audioSender = connection.getSenders().find((sender) => sender.track?.kind === 'audio');
			if (videoSender && newVideo) await videoSender.replaceTrack(newVideo);
			if (audioSender && newAudio) await audioSender.replaceTrack(newAudio);
		}
		localStream.getTracks().forEach((track) => track.stop());
		localStream = replacement;
		addVideo(localTileId, displayName, localStream, true);
		publishMediaState();
		showMeetingToast('Camera and microphone updated.');
	} catch { showMeetingToast('Could not apply the selected devices. Check browser permissions.', 'error'); }
});

$('video-effect-select').addEventListener('change', (event) => {
		const effect = event.target.value;
		const localVideo = document.querySelector(`#tile-${localTileId} video`);
		if (!localVideo) return;
		localVideo.classList.remove('effect-soft-blur', 'effect-dim', 'effect-contrast');
		if (effect !== 'none') localVideo.classList.add(`effect-${effect}`);
});

let captionRecognition;
$('captions-toggle').addEventListener('change', (event) => {
		const captionDisplay = $('caption-display');
		const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!event.target.checked) {
			captionDisplay.classList.add('hidden');
			captionRecognition?.stop();
			return;
		}
		if (!Recognition) {
			event.target.checked = false;
			return showMeetingError('Live captions are not supported by this browser.');
		}
		captionDisplay.classList.remove('hidden');
		captionRecognition = new Recognition();
		captionRecognition.continuous = true;
		captionRecognition.interimResults = true;
		captionRecognition.onresult = (resultEvent) => {
			captionDisplay.textContent = [...resultEvent.results].map((result) => result[0].transcript).join(' ');
		};
		captionRecognition.onend = () => { if ($('captions-toggle').checked) captionRecognition.start(); };
		captionRecognition.start();
});

$('email-invite-button').addEventListener('click', () => {
		const email = $('invite-email').value.trim();
		if (!email) return showMeetingError('Enter an email address first.');
		window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Invite to ${currentRoom || 'Gather meeting'}`)}&body=${encodeURIComponent(`Join my meeting: ${meetingLink()}`)}`;
});
$('report-button').addEventListener('click', () => $('report-section').classList.toggle('hidden'));
$('send-report-button').addEventListener('click', () => {
		const report = $('report-text').value.trim();
		if (!report) return showMeetingToast('Describe the problem before sending.', 'error');
		socket.emit('report-problem', report);
		showMeetingToast('Thanks. Your problem report was sent.', 'success');
		$('report-text').value = '';
		$('report-section').classList.add('hidden');
});
socket.on('control-request', ({ id, name }) => {
	if (id === socket.id) return;
	const toast = document.createElement('div');
	toast.className = 'meeting-toast control-request';
	toast.textContent = `${name || 'A participant'} wants to control your shared screen.`;
	const approve = document.createElement('button');
	approve.type = 'button';
	approve.textContent = 'Approve';
	approve.addEventListener('click', () => { socket.emit('control-response', { requester: id, approved: true }); toast.remove(); });
	const deny = document.createElement('button');
	deny.type = 'button';
	deny.textContent = 'Deny';
	deny.addEventListener('click', () => { socket.emit('control-response', { requester: id, approved: false }); toast.remove(); });
	toast.append(approve, deny);
	$('meeting-notifications').appendChild(toast);
});
socket.on('control-response', ({ approved, name }) => {
	showMeetingToast(approved ? `${name || 'Presenter'} approved control.` : `${name || 'Presenter'} denied control.`, approved ? 'success' : 'error');
});
for (const id of ['quick-access-toggle', 'chat-permission-toggle', 'hand-permission-toggle', 'share-permission-toggle', 'audio-permission-toggle', 'video-permission-toggle', 'reaction-permission-toggle']) {
	$(id)?.addEventListener('change', () => {
		if (!isHost) return;
		socket.emit('host-action', {
			action: 'update-settings',
			settings: {
				quickAccess: $('quick-access-toggle').checked,
				chatAllowed: $('chat-permission-toggle').checked,
				handRaiseAllowed: $('hand-permission-toggle').checked,
				screenShareAllowed: $('share-permission-toggle').checked,
				audioAllowed: $('audio-permission-toggle').checked,
				videoAllowed: $('video-permission-toggle').checked,
				reactionsAllowed: $('reaction-permission-toggle').checked,
			},
		});
	});
}