require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.raw({ type: 'audio/wav', limit: '50mb' }));

const PYANNOTE_API_KEY = process.env.PYANNOTE_API_KEY;
const TARGET_FS = 16000;

// Store audio buffer and speaker mapping
let audioBuffer = [];
let previousDiarization = [];
let speakerMapping = {};
let consistentSpeakerTimes = {};
let customSpeakerNames = {}; // Maps consistent IDs to custom names

// Helper functions
function calculateSegmentOverlap(seg1, seg2) {
  const start = Math.max(seg1.start, seg2.start);
  const end = Math.min(seg1.end, seg2.end);
  return Math.max(0, end - start);
}

function findBestSpeakerMapping(newDiarization, prevDiarization) {
  if (!prevDiarization || prevDiarization.length === 0) {
    const mapping = {};
    const seenSpeakers = new Set();

    for (const item of newDiarization) {
      const speaker = item.speaker;
      if (!seenSpeakers.has(speaker)) {
        mapping[speaker] = `SPEAKER_${Object.keys(mapping).length.toString().padStart(2, '0')}`;
        seenSpeakers.add(speaker);
      }
    }
    return mapping;
  }

  // Group segments by speaker
  const newSpeakers = {};
  const prevSpeakers = {};

  for (const item of newDiarization) {
    if (!newSpeakers[item.speaker]) {
      newSpeakers[item.speaker] = [];
    }
    newSpeakers[item.speaker].push(item);
  }

  for (const item of prevDiarization) {
    if (!prevSpeakers[item.speaker]) {
      prevSpeakers[item.speaker] = [];
    }
    prevSpeakers[item.speaker].push(item);
  }

  const mapping = {};
  const usedPrevSpeakers = new Set();

  for (const newSpeaker of Object.keys(newSpeakers)) {
    let bestMatch = null;
    let bestOverlap = 0;

    for (const prevSpeaker of Object.keys(prevSpeakers)) {
      if (usedPrevSpeakers.has(prevSpeaker)) continue;

      let totalOverlap = 0;
      for (const newSeg of newSpeakers[newSpeaker]) {
        for (const prevSeg of prevSpeakers[prevSpeaker]) {
          totalOverlap += calculateSegmentOverlap(newSeg, prevSeg);
        }
      }

      if (totalOverlap > bestOverlap) {
        bestOverlap = totalOverlap;
        bestMatch = prevSpeaker;
      }
    }

    if (bestMatch && bestOverlap > 0) {
      mapping[newSpeaker] = bestMatch;
      usedPrevSpeakers.add(bestMatch);
    } else {
      const newId = `SPEAKER_${Object.keys(consistentSpeakerTimes).length.toString().padStart(2, '0')}`;
      mapping[newSpeaker] = newId;
    }
  }

  return mapping;
}

// Upload audio buffer to Pyannote
async function uploadAudioToPyannote(audioData) {
  const objectKey = `audio-${Date.now()}`;

  // Get presigned URL
  const inputResponse = await axios.post(
    'https://api.pyannote.ai/v1/media/input',
    { url: `media://${objectKey}` },
    {
      headers: {
        'Authorization': `Bearer ${PYANNOTE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const presignedUrl = inputResponse.data.url;

  // Upload audio
  await axios.put(presignedUrl, audioData, {
    headers: {
      'Content-Type': 'audio/wav'
    }
  });

  return objectKey;
}

// Start diarization job
async function startDiarizationJob(objectKey, webhookUrl) {
  const response = await axios.post(
    'https://api.pyannote.ai/v1/diarize',
    {
      url: `media://${objectKey}`,
      webhook: webhookUrl
    },
    {
      headers: {
        'Authorization': `Bearer ${PYANNOTE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

// Poll for job completion (fallback if webhook fails)
async function pollJobStatus(jobId) {
  let attempts = 0;
  const maxAttempts = 60;

  while (attempts < maxAttempts) {
    const response = await axios.get(
      `https://api.pyannote.ai/v1/jobs/${jobId}`,
      {
        headers: {
          'Authorization': `Bearer ${PYANNOTE_API_KEY}`
        }
      }
    );

    const status = response.data.status;

    if (['succeeded', 'failed', 'canceled'].includes(status)) {
      return response.data;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }

  throw new Error('Job polling timeout');
}

// API Endpoints

// Add audio chunk
app.post('/api/audio/add', (req, res) => {
  try {
    audioBuffer.push(req.body);
    res.json({ success: true, bufferSize: audioBuffer.length });
  } catch (error) {
    console.error('Error adding audio:', error);
    res.status(500).json({ error: error.message });
  }
});

// Process accumulated audio
app.post('/api/diarize', async (req, res) => {
  try {
    if (audioBuffer.length === 0) {
      return res.json({ success: false, message: 'No audio to process' });
    }

    // Concatenate all audio chunks
    const fullAudio = Buffer.concat(audioBuffer);

    // Upload to Pyannote
    const objectKey = await uploadAudioToPyannote(fullAudio);

    // Start diarization with webhook
    const webhookUrl = `http://localhost:${PORT}/api/webhook/diarization`;
    const jobData = await startDiarizationJob(objectKey, webhookUrl);

    res.json({
      success: true,
      jobId: jobData.jobId,
      status: jobData.status
    });

    // Also poll as fallback
    try {
      const result = await pollJobStatus(jobData.jobId);
      if (result.status === 'succeeded') {
        processDiarizationResult(result.output.diarization);
      }
    } catch (error) {
      console.error('Polling error:', error);
    }

  } catch (error) {
    console.error('Error starting diarization:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for Pyannote callbacks
app.post('/api/webhook/diarization', (req, res) => {
  try {
    const { status, output } = req.body;

    if (status === 'succeeded' && output && output.diarization) {
      processDiarizationResult(output.diarization);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Process diarization results
function processDiarizationResult(newDiarization) {
  // Find speaker mapping
  speakerMapping = findBestSpeakerMapping(newDiarization, previousDiarization);

  // Recalculate speaking times
  const tempSpeakerTimes = {};
  for (const item of newDiarization) {
    const originalSpeaker = item.speaker;
    const consistentSpeaker = speakerMapping[originalSpeaker];
    const duration = item.end - item.start;

    if (!tempSpeakerTimes[consistentSpeaker]) {
      tempSpeakerTimes[consistentSpeaker] = 0;
    }
    tempSpeakerTimes[consistentSpeaker] += duration;
  }

  consistentSpeakerTimes = tempSpeakerTimes;

  // Update previous diarization with consistent labels
  previousDiarization = newDiarization.map(item => ({
    ...item,
    speaker: speakerMapping[item.speaker]
  }));

  console.log('Updated speaker times:', consistentSpeakerTimes);
}

// Get current speaker times
app.get('/api/speakers', (req, res) => {
  const speakers = Object.keys(consistentSpeakerTimes).map(id => ({
    id,
    name: customSpeakerNames[id] || id,
    time: consistentSpeakerTimes[id] || 0
  }));

  const totalTime = speakers.reduce((sum, s) => sum + s.time, 0);

  res.json({
    speakers,
    totalTime
  });
});

// Update speaker name
app.post('/api/speakers/:id/name', (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    customSpeakerNames[id] = name;

    res.json({ success: true, id, name });
  } catch (error) {
    console.error('Error updating speaker name:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset session
app.post('/api/reset', (req, res) => {
  audioBuffer = [];
  previousDiarization = [];
  speakerMapping = {};
  consistentSpeakerTimes = {};
  customSpeakerNames = {};

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
