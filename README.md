# ⚖️ Balance My Meetings

Real-time speaker time tracking for meetings using AI-powered diarization.

## How It Works

**Algorithm:**
1. User clicks **+ Add Speaker** when each person starts talking (captures their name and timecode)
2. App runs Pyannote diarization with `numSpeakers` = number of speakers added
3. One-to-one greedy matching algorithm maps Pyannote's speaker labels to user-provided names based on timecode proximity
4. Speaking times are calculated and displayed in real-time

**Key Feature:** Each diarization is independent - no complex segment overlap tracking across runs. Names are assigned by finding which Pyannote speaker was talking closest to each button-click timecode.

## Setup

### Prerequisites
- Python 3.8+
- Node.js 16+
- Pyannote.ai API key ([get one here](https://pyannote.ai))

### Installation

```bash
# Install dependencies
npm install
cd backend && python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt

# Configure API key
echo "PYANNOTE_API_KEY=your_key_here" > backend/.env
```

## Running the App

```bash
npm run dev
```

This starts both the Python backend (port 3000) and Electron frontend.

## Usage

1. **Select Audio Input** - Choose your microphone from the dropdown
2. **Start Recording** - Click "Start Recording" to begin capturing audio
3. **Add Speakers** - Click **+ Add Speaker** each time a new person talks
   - Enter their name in the modal
   - The timecode when you clicked + is saved
4. **View Analytics** - Watch the bar chart and timeline update automatically
5. **Pause/Resume** - Use the pause button to exclude breaks from recording time
6. **Edit Names** - Click speaker names in the legend to rename them
7. **Reset** - Clear session and start over

## Configuration

- **Update Period**: How often diarization runs (default: 15 seconds)
- Diarization only starts after at least one speaker is added

## Tech Stack

- **Frontend**: Electron, Vanilla JS
- **Backend**: Python, Flask
- **AI**: Pyannote.ai speaker diarization API

## Challenges

- **Live diarization**: Pyannote's API being asynchronous for the moment, several approaches including voiceprints were tried and the one implemented here (periodic calls on the full file and name assignation with + button) is the most performant and user-friendly one found
- **Tokens consumption**: Pyannote minutes consumption of this app evolves with the square of recording length

## Future improvements

- **Voiceprints**: handle pre-recorded or automatically recorded voiceprints to keep memory of the speakers and avoid re-diarizing the entire file at each period
- **Native live handling**: this app must be transitioned to continuous diarization (eg via websocket) once it is available on Pyannote
