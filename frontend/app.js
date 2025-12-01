const API_BASE = 'http://localhost:3000/api';

// State
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let updateInterval = null;
let diarizationInterval = null;
let recordingTimeInterval = null;

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const periodInput = document.getElementById('periodInput');
const statusText = document.getElementById('statusText');
const recordingTime = document.getElementById('recordingTime');
const speakersChart = document.getElementById('speakersChart');
const totalTimeEl = document.getElementById('totalTime');
const speakerCountEl = document.getElementById('speakerCount');
const durationEl = document.getElementById('duration');

// Event Listeners
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
resetBtn.addEventListener('click', resetSession);

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
    recordingStartTime = Date.now();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    periodInput.disabled = true;
    statusText.textContent = 'Recording...';
    statusText.classList.add('recording');

    // Start recording time display
    updateRecordingTime();
    recordingTimeInterval = setInterval(updateRecordingTime, 1000);

    // Start periodic diarization
    const period = parseInt(periodInput.value) * 1000;
    diarizationInterval = setInterval(triggerDiarization, period);

    // Start speaker display updates
    updateInterval = setInterval(updateSpeakerDisplay, 2000);

  } catch (error) {
    console.error('Error starting recording:', error);
    alert('Error accessing microphone: ' + error.message);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
  }

  isRecording = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  periodInput.disabled = false;
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

  // Trigger final diarization
  triggerDiarization();
}

async function resetSession() {
  if (isRecording) {
    stopRecording();
  }

  try {
    await fetch(`${API_BASE}/reset`, {
      method: 'POST'
    });

    // Clear UI
    speakersChart.innerHTML = `
      <div class="empty-state">
        <p>Start recording to see speaker analytics</p>
      </div>
    `;
    totalTimeEl.textContent = '0s';
    speakerCountEl.textContent = '0';
    durationEl.textContent = '0s';
    recordingTime.textContent = '00:00';
    statusText.textContent = 'Ready';

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
  try {
    statusText.textContent = 'Processing...';

    const response = await fetch(`${API_BASE}/diarize`, {
      method: 'POST'
    });

    const data = await response.json();

    if (data.success) {
      console.log('Diarization started:', data.jobId);
      if (isRecording) {
        statusText.textContent = 'Recording...';
      }
    } else {
      console.log('No audio to process yet');
    }

  } catch (error) {
    console.error('Error triggering diarization:', error);
    if (isRecording) {
      statusText.textContent = 'Recording...';
    }
  }
}

let lastSpeakerData = null;

async function updateSpeakerDisplay() {
  try {
    const response = await fetch(`${API_BASE}/speakers`);
    const data = await response.json();

    const { speakers, totalTime } = data;

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

    // Check if data actually changed
    const currentDataStr = JSON.stringify(speakers);
    if (lastSpeakerData === currentDataStr) {
      return; // No changes, skip update
    }
    lastSpeakerData = currentDataStr;

    // Update stats
    totalTimeEl.textContent = formatTime(totalTime);
    speakerCountEl.textContent = speakers.length;

    // Update chart
    speakersChart.innerHTML = '';

    speakers.forEach(speaker => {
      const percentage = totalTime > 0 ? (speaker.time / totalTime * 100) : 0;

      const row = document.createElement('div');
      row.className = 'speaker-row';

      row.innerHTML = `
        <div class="speaker-header">
          <div class="speaker-name" contenteditable="true" data-speaker-id="${speaker.id}">
            ${speaker.name}
          </div>
          <span class="speaker-time">${formatTime(speaker.time)}</span>
          <span class="speaker-percentage">(${percentage.toFixed(1)}%)</span>
        </div>
        <div class="bar-container">
          <div class="bar" style="width: ${percentage}%"></div>
        </div>
      `;

      speakersChart.appendChild(row);
    });

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

  const elapsed = Date.now() - recordingStartTime;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  recordingTime.textContent =
    `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;

  durationEl.textContent = formatTime(seconds);
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
