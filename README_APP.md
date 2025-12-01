# Balance My Meetings

Real-time speaker time tracking for meetings using AI-powered speaker diarization.

## Features

- 🎤 **Live Microphone Recording** - Continuous audio capture without interruption
- 📊 **Real-time Analytics** - Live horizontal bar graph showing speaker time distribution
- 🏷️ **Editable Speaker Names** - Click on any speaker name to customize it
- ⚙️ **Customizable Update Period** - Set how often diarization runs (5-60 seconds)
- 🔄 **Consistent Speaker Tracking** - Advanced algorithm maintains speaker identity across updates
- ▶️ **Start/Stop Control** - Unlimited recording time with simple controls

## Architecture

### Backend (Python + Flask)
- **Audio Processing**: Receives audio chunks from frontend
- **Pyannote Integration**: Uploads audio and triggers diarization via Pyannote API
- **Speaker Re-attribution**: Uses segment overlap algorithm to maintain consistent speaker IDs
- **RESTful API**: Provides endpoints for audio upload, speaker data, and name updates

### Frontend (Electron + HTML/CSS/JS)
- **Electron App**: Native desktop application
- **MediaRecorder API**: Captures microphone audio in 5-second chunks
- **Live Bar Chart**: Animated visualization of speaker times
- **Editable UI**: Click-to-edit speaker names with persistence

## Setup

### Prerequisites
- Python 3.9+
- Node.js 16+
- Pyannote API key (get from https://www.pyannote.ai/)

### Installation

1. **Clone the repository**
```bash
cd balance-my-meetings
```

2. **Set up Python backend**
```bash
cd backend
pip install -r requirements.txt
cd ..
```

3. **Set up Electron frontend**
```bash
npm install
```

4. **Configure environment**

Create a `.env` file in the root directory:
```env
PYANNOTE_API_KEY=your_api_key_here
PORT=3000
```

## Running the Application

### Option 1: Run Both Together (Recommended)
```bash
npm run dev
```

This will start both the Python backend and Electron frontend simultaneously.

### Option 2: Run Separately

Terminal 1 (Backend):
```bash
npm run backend
# or
python backend/server.py
```

Terminal 2 (Frontend):
```bash
npm start
```

## Usage

1. **Start Recording**: Click the "Start Recording" button to begin capturing audio
2. **Set Update Period**: Adjust the update period (default 15 seconds) before starting
3. **Monitor Speakers**: Watch the live bar graph update with speaker time distribution
4. **Edit Names**: Click on any speaker name (e.g., "SPEAKER_00") to rename them
5. **Stop Recording**: Click "Stop Recording" when done
6. **Reset**: Use "Reset" button to clear all data and start fresh

## How It Works

### Speaker Re-attribution Algorithm

The app solves a key challenge: Pyannote may assign different labels to the same speaker across diarization runs. Our solution:

1. **Periodic Re-diarization**: Every N seconds, re-diarize the entire audio from start to current time
2. **Segment Overlap Matching**: Compare new diarization with previous results
3. **Best Match Finding**: For each new speaker, find the previous speaker with maximum segment overlap
4. **Consistent ID Assignment**: Map new labels to consistent IDs (SPEAKER_00, SPEAKER_01, etc.)
5. **Time Recalculation**: Recalculate all speaking times using consistent labels

Example:
```
Iteration 1 (0-15s):
  SPEAKER_00 → 8.5s
  SPEAKER_01 → 6.2s

Iteration 2 (0-30s):
  New labels: SPEAKER_02, SPEAKER_00
  Algorithm detects: SPEAKER_02 overlaps with old SPEAKER_00
  Mapping: {SPEAKER_02 → SPEAKER_00, SPEAKER_00 → SPEAKER_01}
  Result:
    SPEAKER_00 → 15.3s (consistent!)
    SPEAKER_01 → 12.1s (consistent!)
```

## API Endpoints

### Backend API (Python Flask)

- `POST /api/audio/add` - Add audio chunk to buffer
- `POST /api/diarize` - Trigger diarization on accumulated audio
- `GET /api/speakers` - Get current speaker times
- `POST /api/speakers/:id/name` - Update speaker custom name
- `POST /api/reset` - Reset session and clear all data
- `GET /api/health` - Health check
- `POST /api/webhook/diarization` - Webhook for Pyannote callbacks

## Project Structure

```
balance-my-meetings/
├── backend/
│   ├── server.py           # Flask server with diarization logic
│   └── requirements.txt    # Python dependencies
├── electron/
│   └── main.js            # Electron main process
├── frontend/
│   ├── index.html         # UI structure
│   ├── styles.css         # Styling
│   └── app.js             # Frontend logic
├── package.json           # Node.js dependencies
├── .env                   # Environment variables
└── README_APP.md          # This file
```

## Technologies Used

- **Backend**: Python, Flask, Requests
- **Frontend**: Electron, HTML5, CSS3, JavaScript
- **AI/ML**: Pyannote.ai API for speaker diarization
- **Audio**: Web MediaRecorder API

## Troubleshooting

### "Backend unavailable" error
- Make sure Python backend is running on port 3000
- Check that PYANNOTE_API_KEY is set in .env

### No speakers detected
- Ensure microphone permissions are granted
- Verify audio is being captured (check browser console)
- Wait for first diarization cycle to complete

### Speaker names not persisting
- Names are stored in-memory during session
- Use Reset button to clear and start fresh

## License

MIT
