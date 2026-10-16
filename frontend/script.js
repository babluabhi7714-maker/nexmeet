const socket = io();
const peers = new Map();
const pendingPeerConnections = new Map();
const remoteAudioPlayers = new Map();
let localStream;
let screenStream;
let currentRoom;
let displayName;
let handRaised = false;
let localTileId;
let isHost = false;
let isPresenter = false;
let recorder;
let recordingChunks = [];
const participants = new Map();
const activePresentations = new Set();
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let pendingQueue = [];
let preferredAudioInputId = null;
let preferredAudioOutputId = null;
let currentConnectionState = 'new';
let iceRestartInProgress = false;
let isHeadphonesConnected = false;
let cameraFacingMode = 'user';
const raisedHandNotifications = new Map();
const audioAnalyzers = new Map();
let audioContext;
let activeSpeakerId = null;
let pinnedParticipantId = null;
let activeSpeakerCandidate = null;
let activeSpeakerCandidateSince = 0;
let activeSpeakerLastHeard = 0;
let activeSpeakerLastSwitch = 0;
let hideVideoTiles = false;
let showOtherReactions = true;
let animateReactions = true;
let meetingStartedAt = null;
let meetingDurationTimer = null;
let captionRecognition;
let captionRestartTimer = null;
let captionsEnabled = false;
let audioUnlockNotice;

const $ = (id) => document.getElementById(id);
const joinScreen = $('join-screen');
const meetingScreen = $('meeting-screen');
const waitingScreen = $('waiting-screen');
const videoGrid = $('video-grid');
const speakerLayout = $('speaker-layout');
const speakerStage = $('speaker-stage');
const participantRail = $('participant-rail');
const selfPreviewLayer = $('self-preview-layer');

function updateMeetingDuration() {
	if (!meetingStartedAt) return;
	const elapsedSeconds = Math.floor((Date.now() - meetingStartedAt) / 1000);
	const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
	const seconds = String(elapsedSeconds % 60).padStart(2, '0');
	$('meeting-duration').textContent = `${minutes}:${seconds}`;
}

function startMeetingDuration() {
	if (meetingDurationTimer) return;
	meetingStartedAt = Date.now();
	updateMeetingDuration();
	meetingDurationTimer = window.setInterval(updateMeetingDuration, 1000);
}

function addVideo(id, name, stream, local = false) {
	let tile = document.getElementById(`tile-${id}`);
	if (!tile) {
		tile = document.createElement('article');
		tile.className = `video-tile${local ? ' local-tile' : ''}`;
		tile.id = `tile-${id}`;
		tile.setAttribute('role', 'button');
		tile.tabIndex = 0;
		tile.innerHTML = `<video autoplay playsinline></video><div class="video-overlay"><div class="avatar-overlay"><span class="avatar-letter"></span><span class="avatar-name"></span></div><div class="mute-badge">🔇</div></div><span class="hand-indicator" aria-label="Hand raised">&#9995;</span><div class="tile-footer"><span class="avatar">${name.charAt(0).toUpperCase()}</span><span class="tile-name"></span><span class="role-badge"></span></div>`;
		tile.querySelector('.avatar-letter').textContent = name.charAt(0).toUpperCase();
		tile.querySelector('.avatar-name').textContent = local ? `${name} (You)` : name;
		tile.querySelector('.tile-name').textContent = local ? `${name} (You)` : name;
		tile.querySelector('.hand-indicator').classList.toggle('visible', Boolean(participants.get(id)?.handRaised));
		tile.setAttribute('aria-label', `Make ${local ? 'your' : name + "'s"} video the main view`);
		const activateTile = () => {
			if (pinnedParticipantId === id) return;
			pinnedParticipantId = null;
			activeSpeakerCandidate = null;
			setActiveSpeaker(id);
		};
		tile.addEventListener('click', activateTile);
		tile.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				activateTile();
			}
		});
		videoGrid.appendChild(tile);
	}
	const video = tile.querySelector('video');
	video.autoplay = true;
	video.playsInline = true;
	video.setAttribute('playsinline', '');
	video.setAttribute('autoplay', '');
	if (video.srcObject !== stream) video.srcObject = stream;
	tile.classList.toggle('presentation-tile', id.startsWith('presentation-'));
	applyAudioOutputPreference(video);
	setupAudioAnalyser(id, video, stream, local);
	video.muted = true;
	const playPreview = () => video.play().catch(() => {
		if (!local) showMeetingError('Click anywhere in the meeting to enable participant audio.');
	});
	const refreshTileVideo = () => {
		updateBadges(id);
		tile.classList.toggle('video-ready', video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
	};
	video.onloadedmetadata = () => { playPreview(); refreshTileVideo(); };
	video.onloadeddata = refreshTileVideo;
	video.onplaying = refreshTileVideo;
	video.onresize = refreshTileVideo;
	playPreview();
	updateBadges(id);
	updateCount();
	applyDynamicVideoGridLayout();
}

function setupAudioAnalyser(id, video, stream, local) {
	if (audioAnalyzers.has(id)) return true;
	if (!stream?.getAudioTracks?.().length) return false;
	try {
		audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
		if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
		const audioStream = new MediaStream(stream.getAudioTracks());
		const source = audioContext.createMediaStreamSource(audioStream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 512;
		source.connect(analyser);
		audioAnalyzers.set(id, { analyser, source, stream: audioStream, data: new Uint8Array(analyser.fftSize) });
		if (!window.activeSpeakerLoopStarted) {
			window.activeSpeakerLoopStarted = true;
			requestAnimationFrame(updateActiveSpeaker);
		}
		return true;
	} catch {
		showMeetingToast('Active speaker detection is unavailable in this browser.', 'error');
		return false;
	}
}

function resumeMeetingAudio() {
	if (audioContext && audioContext.state !== 'running') audioContext.resume().catch(() => {});
	for (const audio of remoteAudioPlayers.values()) {
		if (audio.paused) audio.play().catch(showAudioUnlockNotice);
	}
}

function showAudioUnlockNotice() {
	if (audioUnlockNotice?.isConnected || !$('meeting-notifications')) return;
	const notice = document.createElement('div');
	notice.className = 'meeting-toast error audio-playback-prompt';
	const message = document.createElement('span');
	message.textContent = 'Your browser blocked participant audio.';
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = 'Enable audio';
	button.addEventListener('click', async () => {
		const players = [...remoteAudioPlayers.values()];
		const results = await Promise.all(players.map((audio) => audio.play().then(() => true, () => false)));
		if (results.every(Boolean)) notice.remove();
	});
	notice.append(message, button);
	$('meeting-notifications').appendChild(notice);
	audioUnlockNotice = notice;
}

function playRemoteAudio(id, stream) {
	let audio = remoteAudioPlayers.get(id);
	if (!audio) {
		audio = document.createElement('audio');
		audio.className = 'remote-audio-player';
		audio.autoplay = true;
		audio.playsInline = true;
		audio.setAttribute('aria-hidden', 'true');
		audio.tabIndex = -1;
		document.body.appendChild(audio);
		remoteAudioPlayers.set(id, audio);
	}
	audio.muted = false;
	audio.volume = 1;
	if (audio.srcObject !== stream) audio.srcObject = stream;
	applyAudioOutputPreference(audio);
	audio.play().catch(showAudioUnlockNotice);
}

function removeRemoteAudio(id) {
	remoteAudioPlayers.get(id)?.remove();
	remoteAudioPlayers.delete(id);
	if (!remoteAudioPlayers.size && audioUnlockNotice?.isConnected) {
		audioUnlockNotice.remove();
		audioUnlockNotice = null;
	}
}

document.addEventListener('pointerdown', resumeMeetingAudio, { capture: true });
document.addEventListener('keydown', resumeMeetingAudio, { capture: true });

function chooseFallbackSpeaker(excludedId = null) {
	const candidates = [...videoGrid.querySelectorAll('.video-tile')].filter((tile) => tile.id !== `tile-${excludedId}` && !(tile.classList.contains('local-tile') && !tile.classList.contains('presentation-tile')));
	const remoteHost = candidates.find((tile) => participants.get(tile.id.slice(5))?.isHost);
	const remoteCamera = candidates.find((tile) => !tile.classList.contains('presentation-tile'));
	return (remoteHost || remoteCamera || candidates[0])?.id.slice(5) || null;
}

function setActiveSpeaker(id) {
	const tiles = [...videoGrid.querySelectorAll('.video-tile')];
	if (id) {
		const selectedTile = tiles.find((tile) => tile.id === `tile-${id}`);
		if (!selectedTile) id = chooseFallbackSpeaker(id);
	}
	if (!id || !id.startsWith('presentation-')) {
		if (id && activeSpeakerId !== id) activeSpeakerLastSwitch = performance.now();
		activeSpeakerId = id || null;
		videoGrid.classList.remove('active-speaker-mode');
		tiles.forEach((tile) => {
			tile.classList.remove('main-speaker', 'speaker-thumbnail', 'self-preview');
			tile.classList.toggle('active-speaker', tile.id === `tile-${id}`);
			videoGrid.appendChild(tile);
		});
		speakerLayout.classList.add('hidden');
		applyDynamicVideoGridLayout();
		return;
	}
	const destinationForTile = (tile) => tile.id === `tile-${id}`
		? speakerStage
		: tile.classList.contains('local-tile') && !tile.classList.contains('presentation-tile')
			? selfPreviewLayer
			: participantRail;
	const layoutIsCurrent = tiles.every((tile) => tile.parentElement === destinationForTile(tile));
	if (activeSpeakerId === id && layoutIsCurrent) return;
	if (activeSpeakerId !== id) {
		activeSpeakerId = id;
		activeSpeakerLastSwitch = performance.now();
	}
	videoGrid.classList.add('active-speaker-mode');
	tiles.forEach((tile) => {
		const isMainSpeaker = tile.id === `tile-${id}`;
		tile.classList.toggle('main-speaker', isMainSpeaker);
		tile.classList.toggle('speaker-thumbnail', !isMainSpeaker);
		tile.classList.remove('self-preview');
		tile.classList.toggle('active-speaker', isMainSpeaker);
		destinationForTile(tile).appendChild(tile);
	});
	speakerLayout.classList.remove('hidden');
}

function getMicrophoneLevel(entry) {
	entry.analyser.getByteTimeDomainData(entry.data);
	let energy = 0;
	for (const value of entry.data) {
		const normalized = (value - 128) / 128;
		energy += normalized * normalized;
	}
	return Math.sqrt(energy / entry.data.length);
}

function updateActiveSpeaker() {
	if (screenStream && document.getElementById(`tile-presentation-${socket.id}`)) {
		pinnedParticipantId = `presentation-${socket.id}`;
		setActiveSpeaker(pinnedParticipantId);
	} else {
		const remotePresentationId = [...activePresentations].pop();
		if (remotePresentationId && document.getElementById(`tile-presentation-${remotePresentationId}`)) {
			pinnedParticipantId = `presentation-${remotePresentationId}`;
			setActiveSpeaker(pinnedParticipantId);
		} else if (!screenStream && audioAnalyzers.size && participants.size > 1) {
			let loudestId = null;
			let loudestLevel = 0;
			for (const [id, entry] of audioAnalyzers) {
				if (id.startsWith('presentation-')) continue;
				const participant = participants.get(id);
				const microphoneTrack = entry.stream.getAudioTracks()[0];
				if (participant?.mediaState?.audioMuted || !microphoneTrack?.enabled || microphoneTrack.readyState !== 'live') continue;
				if (!document.getElementById(`tile-${id}`)) continue;
				const level = getMicrophoneLevel(entry);
				if (level > loudestLevel) { loudestLevel = level; loudestId = id; }
			}
			const now = performance.now();
			const currentLevel = activeSpeakerId ? (() => {
				const current = audioAnalyzers.get(activeSpeakerId);
				const participant = participants.get(activeSpeakerId);
				const microphoneTrack = current?.stream.getAudioTracks()[0];
				if (!current || participant?.mediaState?.audioMuted || !microphoneTrack?.enabled || microphoneTrack.readyState !== 'live') return 0;
				return getMicrophoneLevel(current);
			})() : 0;

			if (!activeSpeakerId && loudestId && loudestLevel > 0.06) {
				activeSpeakerCandidate = loudestId;
				activeSpeakerCandidateSince = now;
				setActiveSpeaker(loudestId);
				activeSpeakerLastHeard = now;
				return requestAnimationFrame(updateActiveSpeaker);
			}

			if (loudestId && loudestLevel > 0.06) {
				activeSpeakerLastHeard = now;
				if (activeSpeakerId === loudestId) {
					activeSpeakerCandidate = null;
				} else if (loudestLevel > currentLevel + 0.015) {
					if (activeSpeakerCandidate !== loudestId) {
						activeSpeakerCandidate = loudestId;
						activeSpeakerCandidateSince = now;
					}
					if (now - activeSpeakerCandidateSince > 350 && now - activeSpeakerLastSwitch > 1000) {
						setActiveSpeaker(loudestId);
						activeSpeakerCandidate = null;
					}
				}
			} else if (activeSpeakerId && now - activeSpeakerLastHeard > 2200) {
				activeSpeakerCandidate = null;
				// Keep the current speaker when no one is talking to avoid flicker and noisy fallback switching.
			}
		} else if (activeSpeakerId && participants.size <= 1) {
			setActiveSpeaker(null);
		}
	}
	requestAnimationFrame(updateActiveSpeaker);
}

function applyVideoTilePreference() {
	videoGrid.classList.toggle('hide-video-tiles', hideVideoTiles);
}

function showFloatingReaction(reaction, name, own = false) {
	if (!own && !showOtherReactions) return;
	const layer = $('reaction-layer');
	if (!layer) return;
	const item = document.createElement('span');
	item.className = `floating-reaction${animateReactions ? '' : ' static-reaction'}`;
	item.textContent = reaction;
	item.title = name || 'Reaction';
	layer.appendChild(item);
	window.setTimeout(() => item.remove(), animateReactions ? 2800 : 1800);
}

function updateBadges(id) {
	const tile = document.getElementById(`tile-${id}`);
	if (!tile) return;
	const participant = participants.get(id);
	const avatarOverlay = tile.querySelector('.avatar-overlay');
	const muteBadge = tile.querySelector('.mute-badge');
	if (!avatarOverlay || !muteBadge) return;
	const video = tile.querySelector('video');
	const hasLiveVideo = video.srcObject?.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
	const hasVideoFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
	const videoUnavailable = Boolean(participant?.mediaState?.videoMuted) || !hasLiveVideo || !hasVideoFrame;
	video.classList.toggle('video-unavailable', videoUnavailable);
	tile.classList.toggle('video-ready', !videoUnavailable);
	avatarOverlay.classList.toggle('visible', videoUnavailable);
	avatarOverlay.querySelector('.avatar-name').textContent = `${participant?.name || tile.querySelector('.tile-name').textContent.replace(' (You)', '')}${videoUnavailable ? ' · Camera off' : ''}`;
	const roleBadge = tile.querySelector('.role-badge');
	const role = participant?.isHost ? 'Host' : participant?.role === 'presenter' ? 'Presenter' : '';
	roleBadge.textContent = role;
	roleBadge.classList.toggle('visible', Boolean(role));
	
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

function applyDynamicVideoGridLayout() {
	if (!videoGrid || videoGrid.classList.contains('active-speaker-mode')) return;
	const visibleTiles = [...videoGrid.querySelectorAll('.video-tile')].filter((tile) => tile.offsetParent !== null && !tile.classList.contains('presentation-tile'));
	const count = Math.max(visibleTiles.length, 1);
	let columns = 1;
	if (count === 2) columns = 2;
	else if (count >= 3 && count <= 4) columns = 2;
	else if (count >= 5 && count <= 6) columns = 3;
	else if (count >= 7) columns = Math.min(4, Math.ceil(Math.sqrt(count)));
	const rows = Math.ceil(count / columns);
	const gap = 10;
	const availableWidth = videoGrid.clientWidth || 960;
	const availableHeight = videoGrid.clientHeight || 540;
	const columnWidth = (availableWidth - gap * (columns - 1)) / columns;
	const rowSpace = (availableHeight - gap * (rows - 1)) / rows;
	const minTileHeight = Math.min(window.innerWidth <= 520 ? 82 : window.innerWidth <= 900 ? 104 : 120, columnWidth * 9 / 16);
	const tileHeight = Math.floor(Math.min(columnWidth * 9 / 16, rowSpace));
	const needsScroll = tileHeight < minTileHeight;
	const finalTileHeight = needsScroll ? minTileHeight : tileHeight;
	const finalTileWidth = Math.floor(finalTileHeight * 16 / 9);
	videoGrid.style.setProperty('--grid-columns', columns);
	videoGrid.style.setProperty('--grid-rows', rows);
	videoGrid.style.gridTemplateColumns = `repeat(${columns}, ${finalTileWidth}px)`;
	videoGrid.style.gridTemplateRows = `repeat(${rows}, ${finalTileHeight}px)`;
	videoGrid.style.alignContent = needsScroll ? 'start' : 'center';
	videoGrid.style.justifyContent = 'center';
	videoGrid.style.overflowY = needsScroll ? 'auto' : 'hidden';
	videoGrid.querySelectorAll('.video-tile').forEach((tile) => {
		tile.style.width = `${finalTileWidth}px`;
		tile.style.minHeight = `${finalTileHeight}px`;
		tile.style.height = `${finalTileHeight}px`;
	});
}

window.addEventListener('resize', applyDynamicVideoGridLayout);
document.addEventListener('fullscreenchange', applyDynamicVideoGridLayout);

function updateCount() {
	$('participant-count').textContent = participants.size || videoGrid.querySelectorAll('.video-tile').length;
	if (activeSpeakerId) setActiveSpeaker(activeSpeakerId);
	applyDynamicVideoGridLayout();
}

function showRemotePresentation(id) {
	if (!activePresentations.has(id)) return;
	const peer = peers.get(id);
	const videoTrack = peer?.remoteScreenStream.getVideoTracks().find((track) => track.readyState === 'live');
	if (!peer || !videoTrack || videoTrack.muted) return;
	const tileId = `presentation-${id}`;
	addVideo(tileId, `${peer.name}'s screen`, peer.remoteScreenStream);
	const video = document.querySelector(`#tile-${tileId} video`);
	const promotePresentation = () => {
		if (!activePresentations.has(id) || !video.videoWidth || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
		pinnedParticipantId = tileId;
		setActiveSpeaker(tileId);
	};
	if (video.videoWidth && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) promotePresentation();
	else video.addEventListener('loadeddata', promotePresentation, { once: true });
}

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
	const roomId = String(room || $('room')?.value.trim() || createRoomCode()).trim();
	return `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
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
		label.className = 'participant-name';
		const muteStatus = participant.mediaState?.audioMuted ? ' · 🔇' : '';
		const videoStatus = participant.mediaState?.videoMuted ? ' · 📹' : '';
		label.textContent = `${participant.name}${id === socket.id ? ' (You)' : ''}${participant.isHost ? ' · Host' : ''}${participant.role === 'presenter' ? ' · Presenter' : ''}${muteStatus}${videoStatus}`;
		row.appendChild(label);
		if (isHost && id !== socket.id && !participant.isHost) {
			const actions = document.createElement('div');
			actions.className = 'participant-actions';
			const mute = document.createElement('button');
			mute.type = 'button';
			mute.textContent = participant.mediaState?.audioMuted ? 'Unmute' : 'Mute';
			mute.addEventListener('click', () => socket.emit('host-action', { action: 'mute', target: id }));
			const presenter = document.createElement('button');
			presenter.type = 'button';
			presenter.textContent = participant.role === 'presenter' ? 'Revoke' : 'Present';
			presenter.title = participant.role === 'presenter' ? 'Revoke presenter' : 'Make presenter';
			presenter.addEventListener('click', () => socket.emit('host-action', { action: 'give-presenter', target: id }));
			const remove = document.createElement('button');
			remove.type = 'button'; remove.textContent = 'Remove';
			remove.addEventListener('click', () => socket.emit('host-action', { action: 'remove', target: id }));
			actions.append(mute, presenter, remove);
			row.appendChild(actions);
		}
		list.appendChild(row);
	}
	for (const id of participants.keys()) updateBadges(id);
	updateCount();
}

function renderWaitingQueue(queue) {
	const queueDiv = $('waiting-queue');
	const pendingUsersDiv = $('pending-users');
	pendingQueue = Array.isArray(queue) ? queue : [];
	const visibleCount = isHost ? pendingQueue.length : 0;
	const waitingCount = $('waiting-count');
	waitingCount.textContent = visibleCount > 9 ? '9+' : String(visibleCount);
	waitingCount.classList.toggle('hidden', visibleCount === 0);
	waitingCount.setAttribute('aria-label', `${visibleCount} people waiting to join`);
	
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

async function ensureLocalAudioTrack() {
	if (!localStream || localStream.getAudioTracks().length) return;
	try {
		const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
		const micTrack = audioOnly.getAudioTracks()[0];
		if (micTrack) localStream.addTrack(micTrack);
		audioOnly.getTracks().forEach((track) => track.stop());
	} catch {
		showMeetingToast('Microphone access is required for other participants to hear you.', 'error');
	}
}

async function createPeer(id, name, initiator) {
	if (peers.has(id)) return peers.get(id).connection;
	if (pendingPeerConnections.has(id)) return pendingPeerConnections.get(id);
	const pendingConnection = createPeerConnection(id, name, initiator);
	pendingPeerConnections.set(id, pendingConnection);
	try {
		return await pendingConnection;
	} finally {
		if (pendingPeerConnections.get(id) === pendingConnection) pendingPeerConnections.delete(id);
	}
}

function isScreenMediaTrack(peer, transceiver) {
	if (!peer || !transceiver) return false;
	if (transceiver === peer.screenVideoTransceiver || transceiver === peer.screenAudioTransceiver) return true;
	if (transceiver.mid === null) return false;
	const kind = transceiver.receiver.track?.kind;
	const cameraTransceiver = kind === 'video' ? peer.cameraVideoTransceiver : peer.cameraAudioTransceiver;
	if (cameraTransceiver?.mid === transceiver.mid) return false;
	return !cameraTransceiver || transceiver.mid !== cameraTransceiver.mid;
}

async function synchronizeScreenTransceivers(peer, answeringOffer = false) {
	const transceivers = peer.connection.getTransceivers();
	const findNegotiated = (current, kind) => current?.mid !== null
		? current
		: transceivers.find((transceiver) => transceiver.mid !== null && !transceiver.sender.track && transceiver.receiver.track?.kind === kind) || current;
	const videoTransceiver = findNegotiated(peer.screenVideoTransceiver, 'video');
	const audioTransceiver = findNegotiated(peer.screenAudioTransceiver, 'audio');
	if (answeringOffer) {
		videoTransceiver.direction = 'sendrecv';
		audioTransceiver.direction = 'sendrecv';
	}
	if (peer.screenVideoSender !== videoTransceiver.sender && peer.screenVideoSender.track) {
		await peer.screenVideoSender.replaceTrack(null).catch(() => {});
	}
	if (peer.screenAudioSender !== audioTransceiver.sender && peer.screenAudioSender.track) {
		await peer.screenAudioSender.replaceTrack(null).catch(() => {});
	}
	peer.screenVideoTransceiver = videoTransceiver;
	peer.screenAudioTransceiver = audioTransceiver;
	peer.screenVideoSender = videoTransceiver.sender;
	peer.screenAudioSender = audioTransceiver.sender;
	if (screenStream) {
		const videoTrack = screenStream.getVideoTracks()[0];
		const audioTrack = screenStream.getAudioTracks()[0] || null;
		if (videoTrack && peer.screenVideoSender.track !== videoTrack) await peer.screenVideoSender.replaceTrack(videoTrack);
		if (peer.screenAudioSender.track !== audioTrack) await peer.screenAudioSender.replaceTrack(audioTrack);
	}
}

async function createPeerConnection(id, name, initiator) {
	if (!localStream) return null;
	await ensureLocalAudioTrack();
	const connection = new RTCPeerConnection({ iceServers });
	const videoTrack = localStream.getVideoTracks()[0];
	const outgoingStream = new MediaStream([...localStream.getAudioTracks(), ...(videoTrack ? [videoTrack] : [])]);
	let cameraVideoTransceiver;
	let cameraAudioTransceiver;
	outgoingStream.getTracks().forEach((track) => {
		const sender = connection.addTrack(track, outgoingStream);
		const transceiver = connection.getTransceivers().find((candidate) => candidate.sender === sender);
		if (track.kind === 'video') cameraVideoTransceiver = transceiver;
		else if (track.kind === 'audio') cameraAudioTransceiver = transceiver;
	});
	const screenVideoTransceiver = connection.addTransceiver('video', { direction: 'sendrecv' });
	const screenAudioTransceiver = connection.addTransceiver('audio', { direction: 'sendrecv' });
	const remoteStream = new MediaStream();
	const remoteScreenStream = new MediaStream();
	const remoteAudioStream = new MediaStream();
	const remoteScreenAudioStream = new MediaStream();
	const peerState = { connection, name, cameraVideoTransceiver, cameraAudioTransceiver, screenVideoTransceiver, screenAudioTransceiver, screenVideoSender: screenVideoTransceiver.sender, screenAudioSender: screenAudioTransceiver.sender, remoteStream, remoteScreenStream, remoteAudioStream, remoteScreenAudioStream };
	peers.set(id, peerState);
	if (screenStream) {
		const sharedVideo = screenStream.getVideoTracks()[0];
		const sharedAudio = screenStream.getAudioTracks()[0];
		if (sharedVideo) await screenVideoTransceiver.sender.replaceTrack(sharedVideo);
		if (sharedAudio) await screenAudioTransceiver.sender.replaceTrack(sharedAudio);
	}
	connection.onicecandidate = ({ candidate }) => candidate && socket.emit('signal', { target: id, signal: { candidate } });
	connection.ontrack = ({ track, transceiver }) => {
		const peer = peers.get(id);
		const isScreenTrack = isScreenMediaTrack(peer, transceiver);
		if (isScreenTrack && peer) {
			if (track.kind === 'video') {
				peer.screenVideoTransceiver = transceiver;
				peer.screenVideoSender = transceiver.sender;
			} else if (track.kind === 'audio') {
				peer.screenAudioTransceiver = transceiver;
				peer.screenAudioSender = transceiver.sender;
			}
		}
		const stream = isScreenTrack ? remoteScreenStream : remoteStream;
		if (!stream.getTracks().some((receivedTrack) => receivedTrack.id === track.id)) stream.addTrack(track);
		if (track.kind === 'audio' && peer) {
			const audioStream = isScreenTrack ? peer.remoteScreenAudioStream : peer.remoteAudioStream;
			if (!audioStream.getTracks().some((receivedTrack) => receivedTrack.id === track.id)) audioStream.addTrack(track);
			const audioId = isScreenTrack ? `presentation-${id}` : id;
			playRemoteAudio(audioId, audioStream);
			track.addEventListener('unmute', () => playRemoteAudio(audioId, audioStream));
		}
		const tileId = isScreenTrack ? `presentation-${id}` : id;
		const tileName = isScreenTrack ? `${name}'s screen` : name;
		if (isScreenTrack) {
			if (track.kind !== 'video') return;
			if (!track.muted) showRemotePresentation(id);
			track.addEventListener('unmute', () => showRemotePresentation(id), { once: true });
			return;
		}
		addVideo(tileId, tileName, stream);
		if (track.kind === 'video') {
			track.addEventListener('unmute', () => {
				updateBadges(tileId);
				document.querySelector(`#tile-${tileId} video`)?.play().catch(() => {});
			}, { once: true });
			track.addEventListener('mute', () => updateBadges(tileId));
		}
	};
	connection.onconnectionstatechange = () => {
		if (connection.connectionState === 'failed') {
			if (!iceRestartInProgress) {
				showMeetingToast('Could not connect to participant media. Configure TURN_URL, TURN_USERNAME, and TURN_CREDENTIAL in Render for mobile or restricted networks.', 'error');
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
		await synchronizeScreenTransceivers(peerState);
		socket.emit('signal', { target: id, signal: { description: connection.localDescription } });
	}
	return connection;
}

function removePeer(id) {
	const peer = peers.get(id);
	if (peer) peer.connection.close();
	peers.delete(id);
	audioAnalyzers.delete(id);
	removeRemoteAudio(id);
	document.getElementById(`tile-${id}`)?.remove();
	const presentationId = `presentation-${id}`;
	removeRemoteAudio(presentationId);
	document.getElementById(`tile-${presentationId}`)?.remove();
	if (pinnedParticipantId === id || pinnedParticipantId === presentationId) pinnedParticipantId = null;
	if (activeSpeakerId === id || activeSpeakerId === presentationId) setActiveSpeaker(chooseFallbackSpeaker(id));
	updateCount();
	applyDynamicVideoGridLayout();
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

function syncAudioOutputSelects(selectedValue = '') {
	const selects = [$('settings-output-select')].filter(Boolean);
	if (!selects.length) return;
	selects.forEach((select) => {
		const currentValue = selectedValue || select.value || '';
		if (currentValue && !Array.from(select.options).some((option) => option.value === currentValue)) {
			select.value = '';
			return;
		}
		select.value = currentValue || '';
	});
}

function updateMediaControlsUI() {
	const micTrack = localStream?.getAudioTracks()[0];
	const videoTrack = localStream?.getVideoTracks()[0];
	const micEnabled = Boolean(micTrack && micTrack.enabled);
	const cameraEnabled = Boolean(videoTrack && videoTrack.enabled);
	$('mic-button')?.classList.toggle('muted', !micEnabled);
	$('settings-mic-toggle') && ($('settings-mic-toggle').checked = micEnabled);
	const micLabel = document.querySelector('#mic-button small');
	if (micLabel) micLabel.textContent = micEnabled ? 'Microphone' : 'Unmute';
	$('camera-button')?.classList.toggle('muted', !cameraEnabled);
	$('settings-camera-toggle') && ($('settings-camera-toggle').checked = cameraEnabled);
	const cameraLabel = document.querySelector('#camera-button small');
	if (cameraLabel) cameraLabel.textContent = cameraEnabled ? 'Camera' : 'Video off';
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
		participants.set(socket.id, { name: displayName, isHost: false, role: 'participant', mediaState: { audioMuted: false, videoMuted: false } });
		addVideo(localTileId, displayName, localStream, true);
		updateMediaControlsUI();
		setActiveSpeaker(null);
		$('room-title').textContent = currentRoom;
		$('copy-link-button').title = meetingLink();
		joinScreen.classList.add('hidden');
		meetingScreen.classList.add('hidden');
		waitingScreen.classList.add('hidden');
		socket.emit('join-room', { roomId: currentRoom, name: displayName }, ({ state, host }) => {
			if (state === 'pending') {
				joinScreen.classList.add('hidden');
				meetingScreen.classList.add('hidden');
				waitingScreen.classList.remove('hidden');
			} else if (state === 'approved' && host) {
				waitingScreen.classList.add('hidden');
				meetingScreen.classList.remove('hidden');
				startMeetingDuration();
			} else if (state === 'approved') {
				waitingScreen.classList.add('hidden');
				meetingScreen.classList.remove('hidden');
				startMeetingDuration();
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
socket.on('user-joined', ({ id, name }) => { participants.set(id, { name, isHost: false, role: 'participant', mediaState: { audioMuted: false, videoMuted: false } }); renderParticipants(); return createPeer(id, name, false); });
socket.on('signal', async ({ sender, signal }) => {
	if (!peers.has(sender)) await createPeer(sender, 'Guest', false);
	const peer = peers.get(sender);
	if (!peer) return;
	const connection = peer.connection;
	if (signal.description) {
		await connection.setRemoteDescription(signal.description);
		await synchronizeScreenTransceivers(peer, signal.description.type === 'offer');
		if (signal.description.type === 'offer') {
			const answer = await connection.createAnswer();
			await connection.setLocalDescription(answer);
			socket.emit('signal', { target: sender, signal: { description: connection.localDescription } });
		}
	} else if (signal.candidate) await connection.addIceCandidate(signal.candidate).catch(() => {});
});
socket.on('presentation-stopped', ({ id }) => {
	activePresentations.delete(id);
	const presentationId = `presentation-${id}`;
	removeRemoteAudio(presentationId);
	document.getElementById(`tile-${presentationId}`)?.remove();
	if (pinnedParticipantId === presentationId) pinnedParticipantId = null;
	if (activeSpeakerId === presentationId) setActiveSpeaker(chooseFallbackSpeaker(presentationId));
	updateCount();
});
socket.on('presentation-started', ({ id }) => {
	activePresentations.add(id);
	showRemotePresentation(id);
});
socket.on('user-left', (id) => { participants.delete(id); renderParticipants(); removePeer(id); });
socket.on('join-error', (message) => { $('join-error').textContent = message; });
	socket.on('waiting-room', () => {
	joinScreen.classList.add('hidden');
	meetingScreen.classList.add('hidden');
	waitingScreen.classList.remove('hidden');
});
socket.on('approval-granted', () => {
	waitingScreen.classList.add('hidden');
	meetingScreen.classList.remove('hidden');
	startMeetingDuration();
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
	const self = participants.get(socket.id);
	if (self) {
		self.isHost = host;
		self.role = host ? 'host' : 'participant';
	}
	$('host-panel').classList.add('hidden');
	$('record-button').classList.toggle('hidden', !host);
	renderWaitingQueue(pendingQueue);
	if (host) {
		waitingScreen.classList.add('hidden');
		meetingScreen.classList.remove('hidden');
		startMeetingDuration();
	}
	renderParticipants();
});
socket.on('host-changed', (id) => { const participant = participants.get(id); if (participant) participant.isHost = true; renderParticipants(); });
socket.on('participant-role-changed', ({ id, role }) => {
	const participant = participants.get(id);
	if (participant) participant.role = role;
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
	const participant = participants.get(id);
	if (participant) participant.handRaised = raised;
	document.querySelector(`#tile-${id} .hand-indicator`)?.classList.toggle('visible', raised);
	if (raised) showMeetingToast(`${participant?.name || 'A participant'} raised their hand`, 'hand');
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
socket.on('reaction', ({ id, name, reaction }) => {
	if (id === socket.id) return;
	showFloatingReaction(reaction, name);
});
socket.on('permission-denied', (message) => showMeetingToast(message, 'error'));
socket.on('report-received', ({ name, text }) => showMeetingToast(`Report from ${name}: ${text}`, 'error'));
socket.on('report-submitted', () => showMeetingToast('Your report was sent to the host.'));
socket.on('recording-started', ({ name } = {}) => {
	if (!isHost) showMeetingToast(`${name || 'The host'} started recording.`);
});
socket.on('recording-stopped', ({ name } = {}) => {
	if (!isHost) showMeetingToast(`${name || 'The host'} stopped recording.`);
});
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
	const inviteLink = meetingLink(room);
	$('invite-link').value = inviteLink;
	$('invite-box').classList.remove('hidden');
	if (navigator.share) {
		try {
			await navigator.share({ title: 'Gather meeting', text: 'Join my Gather meeting', url: inviteLink });
			return;
		} catch (error) {
			if (error.name === 'AbortError') return;
		}
	}
	try {
		await navigator.clipboard.writeText(inviteLink);
		$('copy-invite-button').textContent = 'Copied';
		window.setTimeout(() => { $('copy-invite-button').textContent = 'Copy'; }, 1800);
	} catch {
		$('copy-invite-button').textContent = 'Copy link';
	}
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
	const track = localStream?.getAudioTracks()[0];
	if (!track) return;
	track.enabled = !track.enabled;
	$('mic-button').classList.toggle('muted', !track.enabled);
	document.querySelector('#mic-button small').textContent = track.enabled ? 'Mute' : 'Unmute';
	$('settings-mic-toggle').checked = track.enabled;
	publishMediaState();
});
$('camera-button').addEventListener('click', () => {
	const track = localStream?.getVideoTracks()[0];
	if (!track) return;
	track.enabled = !track.enabled;
	$('camera-button').classList.toggle('muted', !track.enabled);
	document.querySelector('#camera-button small').textContent = track.enabled ? 'Camera' : 'Video off';
	$('settings-camera-toggle').checked = track.enabled;
	publishMediaState();
});
$('switch-camera-button').addEventListener('click', async () => {
	if (!localStream?.getVideoTracks().length) return showMeetingToast('Camera is not available.', 'error');
	const nextFacingMode = cameraFacingMode === 'user' ? 'environment' : 'user';
	try {
		const replacementStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: nextFacingMode } }, audio: false });
		const replacementTrack = replacementStream.getVideoTracks()[0];
		for (const { connection, screenVideoSender } of peers.values()) {
			const sender = connection.getSenders().find((item) => item.track?.kind === 'video' && item !== screenVideoSender);
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
$('hand-button').addEventListener('click', () => {
	handRaised = !handRaised;
	$('hand-button').classList.toggle('active', handRaised);
	$('hand-button').querySelector('small').textContent = handRaised ? 'Lower hand' : 'Raise hand';
	const participant = participants.get(socket.id);
	if (participant) participant.handRaised = handRaised;
	document.querySelector(`#tile-${localTileId} .hand-indicator`)?.classList.toggle('visible', handRaised);
	socket.emit('hand-raise', handRaised);
	setUtilityPanelOpen(false);
});
$('share-button').addEventListener('click', async () => {
	setUtilityPanelOpen(false);
	if (screenStream) return stopSharing();
	const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices) || navigator.getDisplayMedia?.bind(navigator);
	if (!getDisplayMedia) return showMeetingToast('This browser does not support screen sharing.', 'error');
	try {
		screenStream = await getDisplayMedia({ video: true, audio: true });
		setActiveSpeaker(null);
		const track = screenStream.getVideoTracks()[0];
		if (!track) throw new Error('The browser returned no screen video track.');
		const sharedAudioTrack = screenStream.getAudioTracks()[0];
		for (const { screenVideoSender, screenAudioSender } of peers.values()) {
			await screenVideoSender?.replaceTrack(track);
			await screenAudioSender?.replaceTrack(sharedAudioTrack || null);
		}
		if (sharedAudioTrack) {
			showMeetingToast('Screen and shared-tab audio are being presented.');
		} else {
			showMeetingToast('Screen shared. Select a browser tab and enable Share tab audio to send sound.');
		}
		const presentationId = `presentation-${socket.id}`;
		addVideo(presentationId, `${displayName} screen`, screenStream, true);
		pinnedParticipantId = presentationId;
		setActiveSpeaker(presentationId);
		track.onended = stopSharing;
		$('share-button').classList.add('active');
		document.querySelector('#share-button small').textContent = 'Stop sharing';
		socket.emit('presentation-start');
	} catch (error) {
		if (error.name === 'AbortError' || error.name === 'NotAllowedError') return;
		const message = error.name === 'NotReadableError'
			? 'Your browser could not capture that screen. Close other screen-sharing sessions and try again.'
			: `Screen sharing failed: ${error.message || error.name || 'browser error'}`;
		screenStream?.getTracks().forEach((item) => item.stop());
		screenStream = null;
		videoGrid.classList.remove('presentation-mode');
		showMeetingToast(message, 'error');
	}
});
function stopSharing() {
	for (const { screenVideoSender, screenAudioSender } of peers.values()) {
		screenVideoSender?.replaceTrack(null).catch(() => {});
		screenAudioSender?.replaceTrack(null).catch(() => {});
	}
	screenStream?.getTracks().forEach((item) => item.stop());
	screenStream = null;
	socket.emit('presentation-stop');
	document.getElementById(`tile-presentation-${socket.id}`)?.remove();
	pinnedParticipantId = null;
	videoGrid.classList.remove('presentation-mode');
	addVideo(localTileId, displayName, localStream, true);
	setActiveSpeaker(chooseFallbackSpeaker());
	$('share-button').classList.remove('active');
	document.querySelector('#share-button small').textContent = 'Share screen';
	showMeetingToast('Screen sharing stopped.');
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
	$('header-chat-button').classList.toggle('active', isOpen);
	if (isOpen) {
		$('host-panel').classList.add('hidden');
		$('file-panel').classList.add('hidden');
		setUtilityPanelOpen(false);
	}
}

function setHostPanelOpen(isOpen) {
	$('host-panel').classList.toggle('hidden', !isOpen);
	$('people-button').classList.toggle('active', isOpen);
	if (isOpen) {
		$('chat-panel').classList.remove('open');
		$('file-panel').classList.add('hidden');
		setUtilityPanelOpen(false);
	}
}

function setFilePanelOpen(isOpen) {
	$('file-panel').classList.toggle('hidden', !isOpen);
	if (isOpen) {
		$('chat-panel').classList.remove('open');
		$('host-panel').classList.add('hidden');
		setUtilityPanelOpen(false);
	}
}

$('header-chat-button').addEventListener('click', () => {
	const shouldOpen = !$('chat-panel').classList.contains('open');
	setChatPanelOpen(shouldOpen);
});
$('people-button').addEventListener('click', () => {
	const shouldOpen = $('host-panel').classList.contains('hidden');
	setHostPanelOpen(shouldOpen);
});
$('close-chat').addEventListener('click', () => setChatPanelOpen(false));
$('close-host').addEventListener('click', () => setHostPanelOpen(false));
$('file-button').addEventListener('click', () => {
	const shouldOpen = $('file-panel').classList.contains('hidden');
	setFilePanelOpen(shouldOpen);
});
$('close-files').addEventListener('click', () => setFilePanelOpen(false));
async function copyMeetingLink() {
	const link = meetingLink();
	try {
		await navigator.clipboard.writeText(link);
		return true;
	} catch {
		const input = $('invite-link');
		input.value = link;
		input.focus();
		input.select();
		return document.execCommand('copy');
	}
}
$('copy-link-button').addEventListener('click', async () => {
	const copied = await copyMeetingLink();
	showMeetingToast(copied ? 'Meeting link copied.' : `Meeting link: ${meetingLink()}`, copied ? 'info' : 'error');
});
$('copy-meeting-invite').addEventListener('click', async () => {
	const copied = await copyMeetingLink();
	showMeetingToast(copied ? 'Meeting link copied.' : `Meeting link: ${meetingLink()}`, copied ? 'info' : 'error');
});
$('record-button').addEventListener('click', () => {
	if (!isHost) return showMeetingToast('Only the host can record this meeting.', 'error');
	if (recorder?.state === 'recording') return recorder.stop();
	if (!window.MediaRecorder || !localStream) return showMeetingToast('Recording is not supported by this browser.', 'error');
	const videoTrack = screenStream?.getVideoTracks()[0] || localStream.getVideoTracks()[0];
	if (!videoTrack) return showMeetingToast('Turn on your camera or start presenting before recording.', 'error');
	const recordStream = new MediaStream([videoTrack, ...localStream.getAudioTracks()]);
	recordingChunks = [];
	const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
	try { recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined); } catch { return showMeetingToast('Recording could not start in this browser.', 'error'); }
	recorder.ondataavailable = (event) => event.data.size && recordingChunks.push(event.data);
	recorder.onerror = () => showMeetingToast('The browser stopped the recording because of an error.', 'error');
	recorder.onstop = () => {
		const link = document.createElement('a');
		const downloadUrl = URL.createObjectURL(new Blob(recordingChunks, { type: 'video/webm' }));
		link.href = downloadUrl;
		link.download = `gather-${currentRoom}-${Date.now()}.webm`;
		link.click();
		window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
		$('record-button').classList.remove('active');
		document.querySelector('#record-button small').textContent = 'Record';
		socket.emit('recording-stop');
		showMeetingToast('Recording stopped and saved to downloads.');
	};
	try { recorder.start(); } catch { return showMeetingToast('Recording could not start.', 'error'); }
	socket.emit('recording-start');
	$('record-button').classList.add('active');
	document.querySelector('#record-button small').textContent = 'Stop recording';
	showMeetingToast('Recording started.');
});
$('cancel-wait-button').addEventListener('click', () => { socket.disconnect(); window.location.reload(); });
$('leave-button').addEventListener('click', () => { localStream?.getTracks().forEach((track) => track.stop()); screenStream?.getTracks().forEach((track) => track.stop()); socket.disconnect(); window.location.reload(); });

document.addEventListener('click', () => {
	resumeMeetingAudio();
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
async function toggleMeetingFullscreen() {
	try {
		setChatPanelOpen(false);
		setHostPanelOpen(false);
		setFilePanelOpen(false);
		setUtilityPanelOpen(false);
		$('reaction-picker').classList.add('hidden');
		if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
		else await document.exitFullscreen();
	} catch { showMeetingError('Fullscreen is not available in this browser.'); }
}
fullscreenButton?.addEventListener('click', toggleMeetingFullscreen);
$('settings-fullscreen-button')?.addEventListener('click', toggleMeetingFullscreen);

const utilityPanel = $('utility-panel');
function setUtilityPanelOpen(isOpen) {
	utilityPanel.classList.toggle('hidden', !isOpen);
	if (isOpen) {
		$('chat-panel').classList.remove('open');
		$('host-panel').classList.add('hidden');
		$('file-panel').classList.add('hidden');
	}
}
function openSettingsPanel(focusId) {
	setUtilityPanelOpen(true);
	$('settings-section').classList.remove('hidden');
	utilityPanel.classList.add('show-settings');
	const focusTarget = () => requestAnimationFrame(() => {
		const target = $(focusId);
		target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		target?.focus();
	});
	if (focusId) Promise.resolve(getAudioDevices()).finally(focusTarget);
	else getAudioDevices();
}
$('more-button').addEventListener('click', () => setUtilityPanelOpen(utilityPanel.classList.contains('hidden')));
$('close-utility').addEventListener('click', () => setUtilityPanelOpen(false));

$('reactions-button').addEventListener('click', () => {
	setUtilityPanelOpen(false);
	$('reaction-picker').classList.toggle('hidden');
});
document.querySelectorAll('#reaction-picker [data-reaction]').forEach((button) => button.addEventListener('click', () => {
		const reaction = button.dataset.reaction;
		showFloatingReaction(reaction, displayName, true);
		socket.emit('reaction', reaction);
		$('reaction-picker').classList.add('hidden');
	}));
$('captions-button').addEventListener('click', () => {
	const captions = $('settings-captions-toggle');
	captions.checked = !captions.checked;
	captions.dispatchEvent(new Event('change'));
});
$('audio-button').addEventListener('click', () => {
	openSettingsPanel('settings-output-select');
});

async function getAudioDevices() {
		const outputSelects = [$('settings-output-select')].filter(Boolean);
		const inputSelect = $('settings-input-select');
		const cameraSelect = $('settings-camera-select');
		if ((!outputSelects.length && !inputSelect && !cameraSelect) || !navigator.mediaDevices?.enumerateDevices) return;
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			outputSelects.forEach((select) => {
				const previousValue = select.value || '';
				select.replaceChildren(new Option('Default speaker', ''));
				devices.filter((device) => device.kind === 'audiooutput').forEach((device, index) => {
					select.appendChild(new Option(device.label || `Speaker ${index + 1}`, device.deviceId));
				});
				select.value = previousValue && Array.from(select.options).some((option) => option.value === previousValue) ? previousValue : '';
			});
			const populateInput = (select, kind, label, activeDeviceId) => {
				if (!select) return;
				const previousValue = select.value || activeDeviceId || '';
				select.replaceChildren(new Option(`Default ${label}`, ''));
				devices.filter((device) => device.kind === kind).forEach((device, index) => {
					select.appendChild(new Option(device.label || `${label} ${index + 1}`, device.deviceId));
				});
				select.value = Array.from(select.options).some((option) => option.value === previousValue) ? previousValue : '';
			};
			populateInput(inputSelect, 'audioinput', 'microphone', localStream?.getAudioTracks()[0]?.getSettings().deviceId);
			populateInput(cameraSelect, 'videoinput', 'camera', localStream?.getVideoTracks()[0]?.getSettings().deviceId);
			syncAudioOutputSelects(outputSelects[0]?.value || '');
		} catch { showMeetingError('Could not read your speaker devices.'); }
}
$('settings-output-select')?.addEventListener('change', async (event) => {
		const deviceId = event.target.value;
		const mediaElements = [...document.querySelectorAll('audio, video')];
		const supportedMedia = mediaElements.filter((media) => typeof media.setSinkId === 'function');
		if (mediaElements.length && !supportedMedia.length) {
			showMeetingToast('Speaker selection is not supported by this browser.', 'error');
			return;
		}
		try {
			await Promise.all(supportedMedia.map((media) => media.setSinkId(deviceId)));
			preferredAudioOutputId = deviceId || null;
			syncAudioOutputSelects(deviceId);
			showMeetingToast(deviceId ? 'Speaker changed.' : 'Using the default speaker.');
		} catch {
			event.target.value = preferredAudioOutputId || '';
			syncAudioOutputSelects(preferredAudioOutputId || '');
			showMeetingToast('Could not switch speakers. Check device access and try again.', 'error');
		}
});
$('refresh-audio-button').addEventListener('click', getAudioDevices);

async function replaceLocalDeviceTrack(kind, deviceId) {
	if (!localStream) return;
	const oldTrack = localStream.getTracks().find((track) => track.kind === kind);
	try {
		const constraints = kind === 'audio'
			? { audio: deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : true, video: false }
			: { audio: false, video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : true };
		const replacementStream = await navigator.mediaDevices.getUserMedia(constraints);
		const replacementTrack = replacementStream.getTracks().find((track) => track.kind === kind);
		if (!replacementTrack) throw new Error(`No ${kind} track was returned by the selected device.`);
		replacementTrack.enabled = oldTrack?.enabled ?? true;
		for (const peer of peers.values()) {
			const sender = oldTrack
				? peer.connection.getSenders().find((item) => item.track === oldTrack)
				: kind === 'audio' ? peer.cameraAudioTransceiver?.sender : peer.cameraVideoTransceiver?.sender;
			if (sender) await sender.replaceTrack(replacementTrack);
		}
		if (kind === 'audio') {
			audioAnalyzers.get(localTileId)?.source.disconnect();
			audioAnalyzers.delete(localTileId);
		}
		if (oldTrack) {
			localStream.removeTrack(oldTrack);
			oldTrack.stop();
		}
		localStream.addTrack(replacementTrack);
		const localVideo = document.querySelector(`#tile-${localTileId} video`);
		if (localVideo) localVideo.srcObject = null;
		addVideo(localTileId, displayName, localStream, true);
		updateMediaControlsUI();
		publishMediaState();
		showMeetingToast(`${kind === 'audio' ? 'Microphone' : 'Camera'} changed.`);
	} catch (error) {
		showMeetingToast(error.name === 'NotAllowedError' ? `Allow access to the selected ${kind} device.` : `Could not change the ${kind} device.`, 'error');
		getAudioDevices();
	}
}

$('settings-input-select')?.addEventListener('change', (event) => replaceLocalDeviceTrack('audio', event.target.value));
$('settings-camera-select')?.addEventListener('change', (event) => replaceLocalDeviceTrack('video', event.target.value));

$('settings-mic-toggle')?.addEventListener('change', () => {
	const track = localStream?.getAudioTracks()[0];
	if (!track) return;
	track.enabled = $('settings-mic-toggle').checked;
	const micLabel = document.querySelector('#mic-button small');
	if (micLabel) micLabel.textContent = track.enabled ? 'Microphone' : 'Unmute';
	$('mic-button')?.classList.toggle('muted', !track.enabled);
	publishMediaState();
});

$('settings-camera-toggle')?.addEventListener('change', () => {
	const track = localStream?.getVideoTracks()[0];
	if (!track) return;
	track.enabled = $('settings-camera-toggle').checked;
	const cameraLabel = document.querySelector('#camera-button small');
	if (cameraLabel) cameraLabel.textContent = track.enabled ? 'Camera' : 'Video off';
	$('camera-button')?.classList.toggle('muted', !track.enabled);
	publishMediaState();
});

$('video-effect-select').addEventListener('change', (event) => {
		const effect = event.target.value;
		const localVideo = document.querySelector(`#tile-${localTileId} video`);
		if (!localVideo) return;
		localVideo.classList.remove('effect-soft-blur', 'effect-dim', 'effect-contrast');
		if (effect !== 'none') localVideo.classList.add(`effect-${effect}`);
});

let localCaptionText = '';
const remoteCaptionTranscripts = new Map();
const remoteCaptionTimers = new Map();
let localCaptionTimer = null;

function renderCaptionDisplay() {
	const lines = [...remoteCaptionTranscripts.values()].map((caption) => `${caption.name}: ${caption.text}`);
	if (localCaptionText) lines.push(`You: ${localCaptionText}`);
	$('caption-display').textContent = lines.join('\n');
	$('caption-display').classList.toggle('hidden', lines.length === 0);
}

socket.on('caption', ({ id, name, text, active }) => {
	if (id === socket.id) return;
	window.clearTimeout(remoteCaptionTimers.get(id));
	if (active && text) {
		remoteCaptionTranscripts.set(id, { name: name || 'Participant', text });
		remoteCaptionTimers.set(id, window.setTimeout(() => {
			remoteCaptionTranscripts.delete(id);
			remoteCaptionTimers.delete(id);
			renderCaptionDisplay();
		}, 5000));
	} else {
		remoteCaptionTranscripts.delete(id);
		remoteCaptionTimers.delete(id);
	}
	renderCaptionDisplay();
});

async function ensureCaptionMicrophoneAccess() {
	if (!navigator.mediaDevices?.getUserMedia) return false;
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
		stream.getTracks().forEach((track) => track.stop());
		return true;
	} catch {
		return false;
	}
}

function stopLiveCaptions() {
	captionsEnabled = false;
	window.clearTimeout(captionRestartTimer);
	captionRestartTimer = null;
	const recognition = captionRecognition;
	captionRecognition = null;
	window.clearTimeout(localCaptionTimer);
	localCaptionTimer = null;
	localCaptionText = '';
	renderCaptionDisplay();
	if (socket.connected) socket.emit('caption', { active: false, text: '' });
	try { recognition?.stop(); } catch { /* Recognition may already have ended. */ }
}

function startCaptionRecognition(Recognition) {
	if (!captionsEnabled || captionRecognition) return;
	const recognition = new Recognition();
	captionRecognition = recognition;
	recognition.continuous = true;
	recognition.interimResults = true;
	recognition.lang = navigator.language || 'en-IN';
	recognition.onresult = (resultEvent) => {
		localCaptionText = [...resultEvent.results].slice(resultEvent.resultIndex).map((result) => result[0].transcript).join(' ').trim();
		if (!localCaptionText) return;
		renderCaptionDisplay();
		if (localCaptionText && socket.connected) socket.emit('caption', { active: true, text: localCaptionText });
		window.clearTimeout(localCaptionTimer);
		localCaptionTimer = window.setTimeout(() => {
			localCaptionText = '';
			renderCaptionDisplay();
			if (socket.connected) socket.emit('caption', { active: false, text: '' });
		}, 5000);
	};
	recognition.onerror = (event) => {
		if (!['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) return;
		captionsEnabled = false;
		$('settings-captions-toggle').checked = false;
		window.clearTimeout(captionRestartTimer);
		captionRestartTimer = null;
		captionRecognition = null;
		localCaptionText = '';
		renderCaptionDisplay();
		if (socket.connected) socket.emit('caption', { active: false, text: '' });
		showMeetingToast(event.error === 'audio-capture' ? 'Captions cannot access your microphone.' : 'Allow speech recognition in your browser to use captions.', 'error');
	};
	recognition.onend = () => {
		if (captionRecognition !== recognition) return;
		captionRecognition = null;
		if (captionsEnabled) captionRestartTimer = window.setTimeout(() => startCaptionRecognition(Recognition), 250);
	};
	try {
		recognition.start();
	} catch (error) {
		captionRecognition = null;
		throw error;
	}
}

$('email-invite-button').addEventListener('click', () => {
	const email = $('invite-email').value.trim();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showMeetingToast('Enter a valid email address.', 'error');
	const subject = encodeURIComponent(`Invite to ${currentRoom || 'Gather meeting'}`);
	const body = encodeURIComponent(`Join my meeting: ${meetingLink()}`);
	window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
});
$('settings-button').addEventListener('click', () => {
	openSettingsPanel();
});
$('close-settings').addEventListener('click', () => {
	$('settings-section').classList.add('hidden');
	$('utility-panel').classList.remove('show-settings');
});
$('settings-captions-toggle').addEventListener('change', async (event) => {
	const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!event.target.checked) {
		stopLiveCaptions();
		return;
	}
	if (!Recognition) {
		event.target.checked = false;
		showMeetingToast('Live captions are unavailable in this browser. Try Chrome or Edge.', 'error');
		return;
	}
	const micReady = await ensureCaptionMicrophoneAccess();
	if (!micReady) {
		event.target.checked = false;
		showMeetingToast('Allow microphone access to use live captions.', 'error');
		return;
	}
	captionsEnabled = true;
	try {
		startCaptionRecognition(Recognition);
	} catch {
		captionsEnabled = false;
		event.target.checked = false;
		showMeetingToast('Could not start live captions. Check microphone and browser permissions.', 'error');
	}
});
$('hide-video-tiles-toggle').addEventListener('change', (event) => {
	hideVideoTiles = event.target.checked;
	applyVideoTilePreference();
});
$('show-reactions-toggle').addEventListener('change', (event) => { showOtherReactions = event.target.checked; });
$('reaction-animation-toggle').addEventListener('change', (event) => { animateReactions = event.target.checked; });
$('settings-host-controls').addEventListener('click', () => {
	if (!isHost) return showMeetingToast('Host controls are available to the host only.', 'error');
	$('utility-panel').classList.remove('show-settings');
	setUtilityPanelOpen(false);
	setHostPanelOpen(true);
});
$('settings-feedback').addEventListener('click', () => {
	window.location.href = `mailto:?subject=${encodeURIComponent('Gather meeting feedback')}&body=${encodeURIComponent(`Meeting: ${meetingLink()}`)}`;
});
$('report-button').addEventListener('click', () => $('report-section').classList.toggle('hidden'));
$('send-report-button').addEventListener('click', () => {
	const report = $('report-text').value.trim();
	if (!report) return showMeetingToast('Describe the problem before sending.', 'error');
	if (!socket.connected) return showMeetingToast('You are disconnected; the report was not sent.', 'error');
	socket.emit('report-problem', report);
	$('report-text').value = '';
});