const API_BASE = 'http://localhost:3000/api';

// State
let isRecording = false;
let isPaused = false;
let isDiarizationActive = false;
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let pausedTime = 0; // Accumulated paused time
let pauseStartTime = null;
let updateInterval = null;
let diarizationInterval = null;
let recordingTimeInterval = null;

// Speaker colors - distinctive colors for each speaker
const SPEAKER_COLORS = [
  '#667eea', // Purple
  '#f56565', // Red
  '#48bb78', // Green
  '#ed8936', // Orange
  '#4299e1', // Blue
  '#9f7aea', // Violet
  '#ed64a6', // Pink
  '#38b2ac', // Teal
  '#ecc94b', // Yellow
  '#f687b3', // Light Pink
];

function getSpeakerColor(speakerId) {
  // Extract number from SPEAKER_XX format
  const match = speakerId.match(/\d+/);
  if (match) {
    const index = parseInt(match[0]);
    return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
  }
  return SPEAKER_COLORS[0];
}

// DOM Elements
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const everybodyTalkedBtn = document.getElementById('everybodyTalkedBtn');
const periodInput = document.getElementById('periodInput');
const numSpeakersInput = document.getElementById('numSpeakersInput');
const statusText = document.getElementById('statusText');
const recordingTime = document.getElementById('recordingTime');
const speakersChart = document.getElementById('speakersChart');
const timeline = document.getElementById('timeline');
const timelineLabels = document.getElementById('timelineLabels');
const speakerLegend = document.getElementById('speakerLegend');

// Event Listeners
startBtn.addEventListener('click', startRecording);
pauseBtn.addEventListener('click', togglePause);
stopBtn.addEventListener('click', stopRecording);
resetBtn.addEventListener('click', resetSession);
everybodyTalkedBtn.addEventListener('click', startDiarization);

// Initialize
async function startRecording() {
  try {
    // Get microphone access
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    // Create MediaRecorder
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm'
    });

    audioChunks = [];

    // Handle data available
    mediaRecorder.addEventListener('dataavailable', async (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);

        // Send to backend
        try {
          await sendAudioChunk(event.data);
        } catch (error) {
          console.error('Error sending audio chunk:', error);
        }
      }
    });

    // Start recording in chunks (every 5 seconds)
    mediaRecorder.start(5000);

    // Update UI
    isRecording = true;
    isPaused = false;
    isDiarizationActive = false;
    recordingStartTime = Date.now();
    pausedTime = 0;
    pauseStartTime = null;
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    everybodyTalkedBtn.disabled = false;
    periodInput.disabled = true;
    numSpeakersInput.disabled = true;
    statusText.textContent = 'Recording... (waiting for everyone to talk)';
    statusText.classList.add('recording');

    // Start recording time display
    updateRecordingTime();
    recordingTimeInterval = setInterval(updateRecordingTime, 1000);

    // Don't start diarization yet - wait for "Everybody Talked" button
    // Start speaker display updates
    updateInterval = setInterval(updateSpeakerDisplay, 2000);

  } catch (error) {
    console.error('Error starting recording:', error);
    alert('Error accessing microphone: ' + error.message);
  }
}

function togglePause() {
  if (!isRecording) return;

  if (isPaused) {
    // Resume
    mediaRecorder.resume();
    isPaused = false;
    pauseBtn.textContent = 'Pause';

    // Add accumulated paused time
    if (pauseStartTime) {
      pausedTime += Date.now() - pauseStartTime;
      pauseStartTime = null;
    }

    // Resume intervals if diarization is active
    if (isDiarizationActive) {
      statusText.textContent = 'Recording & Analyzing...';
      const period = parseInt(periodInput.value) * 1000;
      diarizationInterval = setInterval(triggerDiarization, period);
    } else {
      statusText.textContent = 'Recording... (waiting for everyone to talk)';
    }
    statusText.classList.add('recording');

    updateInterval = setInterval(updateSpeakerDisplay, 2000);
  } else {
    // Pause
    mediaRecorder.pause();
    isPaused = true;
    pauseBtn.textContent = 'Resume';
    pauseStartTime = Date.now();

    statusText.textContent = 'Paused';
    statusText.classList.remove('recording');

    // Stop intervals
    if (diarizationInterval) {
      clearInterval(diarizationInterval);
    }
    if (updateInterval) {
      clearInterval(updateInterval);
    }
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
  }

  isRecording = false;
  isPaused = false;
  isDiarizationActive = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  pauseBtn.textContent = 'Pause';
  stopBtn.disabled = true;
  everybodyTalkedBtn.disabled = true;
  periodInput.disabled = false;
  numSpeakersInput.disabled = false;
  statusText.textContent = 'Stopped';
  statusText.classList.remove('recording');

  // Clear intervals
  if (recordingTimeInterval) {
    clearInterval(recordingTimeInterval);
  }
  if (diarizationInterval) {
    clearInterval(diarizationInterval);
  }
  if (updateInterval) {
    clearInterval(updateInterval);
  }

  // Trigger final diarization if it was active
  if (isDiarizationActive) {
    triggerDiarization();
  }
}

function startDiarization() {
  if (!isRecording) return;

  isDiarizationActive = true;
  everybodyTalkedBtn.disabled = true;
  statusText.textContent = 'Recording & Analyzing...';

  // Trigger first diarization immediately
  triggerDiarization();

  // Start periodic diarization
  const period = parseInt(periodInput.value) * 1000;
  diarizationInterval = setInterval(triggerDiarization, period);
}

async function resetSession() {
  if (isRecording) {
    stopRecording();
  }

  try {
    await fetch(`${API_BASE}/reset`, {
      method: 'POST'
    });

    // Reset state
    isDiarizationActive = false;
    lastSpeakerIds = new Set();
    lastSpeakerData = null;

    // Clear UI
    speakerLegend.innerHTML = '<div class="legend-empty">No speakers detected yet</div>';
    speakersChart.innerHTML = `
      <div class="empty-state">
        <p>Start recording to see speaker analytics</p>
      </div>
    `;
    timeline.innerHTML = '<div class="timeline-empty">Timeline will appear once recording starts</div>';
    timelineLabels.innerHTML = '';
    recordingTime.textContent = '00:00';
    statusText.textContent = 'Ready';
    everybodyTalkedBtn.disabled = true;
    numSpeakersInput.disabled = false;
    periodInput.disabled = false;

  } catch (error) {
    console.error('Error resetting session:', error);
  }
}

async function sendAudioChunk(audioBlob) {
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();

    const response = await fetch(`${API_BASE}/audio/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/webm'
      },
      body: arrayBuffer
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('Audio chunk sent, buffer size:', data.bufferSize);

  } catch (error) {
    console.error('Error sending audio chunk:', error);
    throw error;
  }
}

async function triggerDiarization() {
  if (!isDiarizationActive) return;

  try {
    statusText.textContent = 'Processing...';

    const numSpeakers = parseInt(numSpeakersInput.value);

    const response = await fetch(`${API_BASE}/diarize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        numSpeakers: numSpeakers
      })
    });

    const data = await response.json();

    if (data.success) {
      console.log('Diarization started:', data.jobId);
      if (isRecording && isDiarizationActive) {
        statusText.textContent = 'Recording & Analyzing...';
      }
    } else {
      console.log('No audio to process yet');
    }

  } catch (error) {
    console.error('Error triggering diarization:', error);
    if (isRecording && isDiarizationActive) {
      statusText.textContent = 'Recording & Analyzing...';
    }
  }
}

let lastSpeakerData = null;
let totalRecordingDuration = 0;
let lastSpeakerIds = new Set(); // Track which speakers exist

async function updateSpeakerDisplay() {
  try {
    const response = await fetch(`${API_BASE}/speakers`);
    const data = await response.json();

    const { speakers, totalTime, timeline } = data;

    if (speakers.length === 0) {
      return;
    }

    // Check if we're currently editing a speaker name
    const editingElement = document.querySelector('.speaker-name.editing');
    const activeElement = document.activeElement;
    const isEditingName = editingElement || (activeElement && activeElement.classList.contains('speaker-name'));

    // Skip update if user is editing
    if (isEditingName) {
      return;
    }

    // Sort by time (descending)
    speakers.sort((a, b) => b.time - a.time);

    // Check if speaker set changed (added/removed)
    const currentSpeakerIds = new Set(speakers.map(s => s.id));
    const speakerSetChanged = currentSpeakerIds.size !== lastSpeakerIds.size ||
      [...currentSpeakerIds].some(id => !lastSpeakerIds.has(id));

    // Update legend only when speakers are added/removed
    if (speakerSetChanged) {
      updateLegend(speakers);
      lastSpeakerIds = currentSpeakerIds;
    }

    // Check if data actually changed
    const currentDataStr = JSON.stringify(speakers);
    if (lastSpeakerData === currentDataStr) {
      return; // No changes, skip update
    }
    lastSpeakerData = currentDataStr;

    // Update stats
    // Update total recording duration from timeline
    if (timeline && timeline.length > 0) {
      totalRecordingDuration = Math.max(...timeline.map(seg => seg.end));
    }

    // Update chart
    speakersChart.innerHTML = '';

    speakers.forEach(speaker => {
      const percentage = totalTime > 0 ? (speaker.time / totalTime * 100) : 0;
      const color = getSpeakerColor(speaker.id);

      const row = document.createElement('div');
      row.className = 'speaker-row';

      row.innerHTML = `
        <div class="bar-container">
          <div class="bar" style="width: ${percentage}%; background: ${color};">
            <span class="bar-label">${speaker.name}</span>
            <span class="bar-time">${formatTime(speaker.time)} (${percentage.toFixed(1)}%)</span>
          </div>
        </div>
      `;

      speakersChart.appendChild(row);
    });

    // Update timeline
    updateTimeline(timeline, speakers);

    // Add event listeners to editable speaker names
    document.querySelectorAll('.speaker-name').forEach(nameEl => {
      nameEl.addEventListener('blur', async (e) => {
        const speakerId = e.target.dataset.speakerId;
        const newName = e.target.textContent.trim();

        if (newName) {
          await updateSpeakerName(speakerId, newName);
          // Force update after name change
          lastSpeakerData = null;
        }
      });

      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.target.blur();
        }
      });

      nameEl.addEventListener('focus', (e) => {
        e.target.classList.add('editing');
      });

      nameEl.addEventListener('blur', (e) => {
        e.target.classList.remove('editing');
      });
    });

  } catch (error) {
    console.error('Error updating speaker display:', error);
  }
}

function updateLegend(speakers) {
  speakerLegend.innerHTML = '';

  if (speakers.length === 0) {
    speakerLegend.innerHTML = '<div class="legend-empty">No speakers detected yet</div>';
    return;
  }

  speakers.forEach(speaker => {
    const color = getSpeakerColor(speaker.id);

    const item = document.createElement('div');
    item.className = 'legend-item';

    item.innerHTML = `
      <div class="legend-color" style="background: ${color};"></div>
      <div class="legend-name" contenteditable="true" data-speaker-id="${speaker.id}">
        ${speaker.name}
      </div>
    `;

    speakerLegend.appendChild(item);
  });

  // Add event listeners to editable legend names
  document.querySelectorAll('.legend-name').forEach(nameEl => {
    nameEl.addEventListener('blur', async (e) => {
      const speakerId = e.target.dataset.speakerId;
      const newName = e.target.textContent.trim();

      if (newName) {
        await updateSpeakerName(speakerId, newName);
        // Force update display after name change
        lastSpeakerData = null;
      }
    });

    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.blur();
      }
    });

    nameEl.addEventListener('focus', (e) => {
      e.target.classList.add('editing');
    });

    nameEl.addEventListener('blur', (e) => {
      e.target.classList.remove('editing');
    });
  });
}

async function updateSpeakerName(speakerId, newName) {
  try {
    const response = await fetch(`${API_BASE}/speakers/${speakerId}/name`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: newName })
    });

    if (!response.ok) {
      throw new Error('Failed to update speaker name');
    }

    console.log(`Updated speaker ${speakerId} to "${newName}"`);

  } catch (error) {
    console.error('Error updating speaker name:', error);
  }
}

function updateRecordingTime() {
  if (!recordingStartTime) return;

  // Calculate elapsed time excluding paused time
  let elapsed = Date.now() - recordingStartTime - pausedTime;

  // If currently paused, also subtract the current pause duration
  if (isPaused && pauseStartTime) {
    elapsed -= (Date.now() - pauseStartTime);
  }

  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  recordingTime.textContent =
    `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function formatTime(seconds) {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  } else {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
  }
}

function updateTimeline(timelineSegments, speakers) {
  if (!timelineSegments || timelineSegments.length === 0) {
    timeline.innerHTML = '<div class="timeline-empty">Timeline will appear once recording starts</div>';
    return;
  }

  // Clear timeline
  timeline.innerHTML = '';

  // Use current recording time as the total duration for the timeline
  // This ensures the timeline always spans the full width
  const currentTime = (Date.now() - recordingStartTime) / 1000;
  const maxTime = currentTime > 0 ? currentTime : (totalRecordingDuration || Math.max(...timelineSegments.map(seg => seg.end)));

  // Create timeline segments
  timelineSegments.forEach(segment => {
    const startPercent = (segment.start / maxTime) * 100;
    const widthPercent = ((segment.end - segment.start) / maxTime) * 100;
    const color = getSpeakerColor(segment.speaker);

    // Find speaker name
    const speaker = speakers.find(s => s.id === segment.speaker);
    const speakerName = speaker ? speaker.name : segment.speaker;

    const segmentEl = document.createElement('div');
    segmentEl.className = 'timeline-segment';
    segmentEl.style.left = `${startPercent}%`;
    segmentEl.style.width = `${widthPercent}%`;
    segmentEl.style.background = color;

    // Tooltip on hover
    segmentEl.title = `${speakerName}: ${formatTime(segment.start)} - ${formatTime(segment.end)}`;

    timeline.appendChild(segmentEl);
  });
}

// Check backend health on load
async function checkBackend() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (response.ok) {
      console.log('Backend is ready');
    }
  } catch (error) {
    console.error('Backend not available:', error);
    statusText.textContent = 'Backend unavailable';
    statusText.style.color = 'red';
  }
}

checkBackend();
