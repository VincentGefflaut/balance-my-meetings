from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os
from dotenv import load_dotenv
import time
import threading
from datetime import datetime

load_dotenv()

app = Flask(__name__)
CORS(app)

PYANNOTE_API_KEY = os.getenv('PYANNOTE_API_KEY')
TARGET_FS = 16000

# Global state
audio_buffer = []
current_diarization = []  # Latest diarization result from Pyannote
manual_speakers = {}  # {speaker_id: {'name': str, 'timecode': float, 'order': int}}
speaker_counter = 0
audio_lock = threading.Lock()


def calculate_min_distance_to_speaker(timecode, segments):
    """
    Calculate minimum distance from a timecode to any segment of a speaker.
    Returns 0 if timecode falls within a segment.
    """
    min_distance = float('inf')

    for segment in segments:
        if segment['start'] <= timecode <= segment['end']:
            return 0  # Perfect match - timecode is within this segment

        # Calculate distance to segment
        if timecode < segment['start']:
            distance = segment['start'] - timecode
        else:  # timecode > segment['end']
            distance = timecode - segment['end']

        min_distance = min(min_distance, distance)

    return min_distance


def map_pyannote_to_manual_speakers(diarization_segments):
    """
    Create one-to-one mapping between Pyannote speakers and manual speaker names.
    Uses greedy algorithm based on timecode proximity.
    """
    if not manual_speakers:
        return {}

    # Group segments by Pyannote speaker
    pyannote_segments = {}
    for segment in diarization_segments:
        speaker = segment['speaker']
        if speaker not in pyannote_segments:
            pyannote_segments[speaker] = []
        pyannote_segments[speaker].append(segment)

    # Build cost list: (cost, manual_id, pyannote_id)
    costs = []
    for manual_id, manual_data in manual_speakers.items():
        timecode = manual_data['timecode']
        for pyannote_id, segments in pyannote_segments.items():
            cost = calculate_min_distance_to_speaker(timecode, segments)
            costs.append((cost, manual_id, pyannote_id))

    # Sort by cost (ascending) - lowest cost = best match
    costs.sort()

    # Greedy one-to-one assignment
    mapping = {}  # pyannote_id -> manual speaker name
    used_manual = set()
    used_pyannote = set()

    for cost, manual_id, pyannote_id in costs:
        if manual_id not in used_manual and pyannote_id not in used_pyannote:
            mapping[pyannote_id] = manual_speakers[manual_id]['name']
            used_manual.add(manual_id)
            used_pyannote.add(pyannote_id)

            print(f"Matched {manual_speakers[manual_id]['name']} (timecode {manual_speakers[manual_id]['timecode']:.1f}s) -> {pyannote_id} (cost: {cost:.1f}s)")

            # Stop when all speakers are mapped
            if len(mapping) == len(manual_speakers):
                break

    return mapping


def upload_audio_to_pyannote(audio_data):
    """Upload audio buffer to Pyannote API."""
    object_key = f"audio-{int(time.time() * 1000)}"

    # Get presigned URL
    response = requests.post(
        'https://api.pyannote.ai/v1/media/input',
        json={'url': f'media://{object_key}'},
        headers={
            'Authorization': f'Bearer {PYANNOTE_API_KEY}',
            'Content-Type': 'application/json'
        }
    )
    response.raise_for_status()
    presigned_url = response.json()['url']

    # Upload audio
    requests.put(presigned_url, data=audio_data)

    return object_key


def start_diarization_job(object_key, webhook_url=None, num_speakers=None):
    """Start diarization job on Pyannote API."""
    payload = {'url': f'media://{object_key}'}

    if webhook_url:
        payload['webhook'] = webhook_url

    if num_speakers is not None:
        payload['numSpeakers'] = num_speakers

    response = requests.post(
        'https://api.pyannote.ai/v1/diarize',
        json=payload,
        headers={
            'Authorization': f'Bearer {PYANNOTE_API_KEY}',
            'Content-Type': 'application/json'
        }
    )
    response.raise_for_status()

    return response.json()


def poll_job_status(job_id, max_attempts=120):
    """Poll for job completion."""
    attempts = 0

    while attempts < max_attempts:
        response = requests.get(
            f'https://api.pyannote.ai/v1/jobs/{job_id}',
            headers={'Authorization': f'Bearer {PYANNOTE_API_KEY}'}
        )
        response.raise_for_status()

        data = response.json()
        status = data['status']

        if status in ['succeeded', 'failed', 'canceled']:
            return data

        time.sleep(1)
        attempts += 1

    raise Exception('Job polling timeout')


def process_diarization_result(new_diarization):
    """Process diarization results with one-to-one speaker mapping."""
    global current_diarization

    # Store the raw diarization result
    current_diarization = new_diarization
    print(f"Received diarization with {len(set(seg['speaker'] for seg in new_diarization))} speakers")

    # Map Pyannote speakers to manual names
    mapping = map_pyannote_to_manual_speakers(new_diarization)
    print(f"Final mapping: {mapping}")


# API Endpoints

@app.route('/api/audio/add', methods=['POST'])
def add_audio():
    """Add audio chunk to buffer."""
    try:
        audio_data = request.data

        with audio_lock:
            audio_buffer.append(audio_data)

        return jsonify({
            'success': True,
            'bufferSize': len(audio_buffer)
        })

    except Exception as e:
        print(f"Error adding audio: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/diarize', methods=['POST'])
def diarize():
    """Process accumulated audio and run diarization."""
    try:
        # Use number of manual speakers
        num_speakers = len(manual_speakers)

        # Skip diarization if no speakers have been added yet
        if num_speakers == 0:
            return jsonify({
                'success': False,
                'message': 'No speakers added yet. Click + to add speakers.'
            })

        with audio_lock:
            if not audio_buffer:
                return jsonify({
                    'success': False,
                    'message': 'No audio to process'
                })

            # Concatenate all audio chunks
            full_audio = b''.join(audio_buffer)

        print(f"Starting diarization with numSpeakers={num_speakers}")

        # Upload to Pyannote
        object_key = upload_audio_to_pyannote(full_audio)

        # Start diarization job with specific number of speakers
        job_data = start_diarization_job(object_key, num_speakers=num_speakers)
        job_id = job_data['jobId']

        # Poll for results in background thread
        def poll_and_process():
            try:
                result = poll_job_status(job_id)
                if result['status'] == 'succeeded' and 'output' in result:
                    process_diarization_result(result['output']['diarization'])
            except Exception as e:
                print(f"Polling error: {e}")

        thread = threading.Thread(target=poll_and_process)
        thread.daemon = True
        thread.start()

        return jsonify({
            'success': True,
            'jobId': job_id,
            'status': job_data['status']
        })

    except Exception as e:
        print(f"Error starting diarization: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/webhook/diarization', methods=['POST'])
def webhook_diarization():
    """Webhook endpoint for Pyannote callbacks."""
    try:
        data = request.json
        status = data.get('status')
        output = data.get('output')

        if status == 'succeeded' and output and 'diarization' in output:
            process_diarization_result(output['diarization'])

        return jsonify({'received': True})

    except Exception as e:
        print(f"Webhook error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/speakers', methods=['GET'])
def get_speakers():
    """Get current speaker times and timeline segments."""
    speakers = []

    if not current_diarization:
        # No diarization yet - show manual speakers with 0 time
        for manual_id, manual_data in manual_speakers.items():
            speakers.append({
                'id': manual_id,
                'name': manual_data['name'],
                'time': 0
            })

        return jsonify({
            'speakers': speakers,
            'totalTime': 0,
            'timeline': []
        })

    # Get the mapping from Pyannote speakers to manual names
    mapping = map_pyannote_to_manual_speakers(current_diarization)

    # Calculate speaking times for each Pyannote speaker
    speaker_times = {}
    for segment in current_diarization:
        pyannote_id = segment['speaker']
        duration = segment['end'] - segment['start']

        if pyannote_id not in speaker_times:
            speaker_times[pyannote_id] = 0
        speaker_times[pyannote_id] += duration

    # Create speaker list with custom names
    for pyannote_id, time_value in speaker_times.items():
        name = mapping.get(pyannote_id, pyannote_id)  # Use mapped name or fallback to SPEAKER_XX
        speakers.append({
            'id': pyannote_id,
            'name': name,
            'time': time_value
        })

    # Also include manual speakers that haven't been mapped yet (with 0 time)
    mapped_names = set(mapping.values())
    for manual_id, manual_data in manual_speakers.items():
        if manual_data['name'] not in mapped_names:
            speakers.append({
                'id': manual_id,
                'name': manual_data['name'],
                'time': 0
            })

    total_time = sum(s['time'] for s in speakers)

    # Return timeline segments with mapped names
    timeline_segments = []
    for seg in current_diarization:
        pyannote_id = seg['speaker']
        timeline_segments.append({
            'speaker': mapping.get(pyannote_id, pyannote_id),  # Use mapped name
            'start': seg['start'],
            'end': seg['end']
        })

    return jsonify({
        'speakers': speakers,
        'totalTime': total_time,
        'timeline': timeline_segments
    })


@app.route('/api/speakers/add', methods=['POST'])
def add_speaker():
    """Add a new manual speaker name with timecode for mapping."""
    global speaker_counter, manual_speakers

    try:
        data = request.json
        name = data.get('name')
        timecode = data.get('timecode')  # Time in seconds from recording start

        if not name:
            return jsonify({'error': 'Name is required'}), 400
        if timecode is None:
            return jsonify({'error': 'Timecode is required'}), 400

        # Generate manual speaker ID (just for tracking)
        speaker_id = f"MANUAL_{speaker_counter:02d}"
        speaker_counter += 1

        # Store manual speaker timecode and name
        manual_speakers[speaker_id] = {
            'name': name,
            'timecode': timecode,
            'order': len(manual_speakers)
        }

        print(f"Added manual speaker click: {speaker_id} - {name} at {timecode}s")

        return jsonify({
            'success': True,
            'id': speaker_id,
            'name': name,
            'timecode': timecode
        })

    except Exception as e:
        print(f"Error adding speaker: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/speakers/<speaker_id>/name', methods=['POST'])
def update_speaker_name(speaker_id):
    """Update speaker custom name."""
    try:
        data = request.json
        name = data.get('name')

        custom_speaker_names[speaker_id] = name

        return jsonify({
            'success': True,
            'id': speaker_id,
            'name': name
        })

    except Exception as e:
        print(f"Error updating speaker name: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/reset', methods=['POST'])
def reset():
    """Reset session."""
    global audio_buffer, current_diarization, manual_speakers, speaker_counter

    with audio_lock:
        audio_buffer = []

    current_diarization = []
    manual_speakers = {}
    speaker_counter = 0

    return jsonify({'success': True})


@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'timestamp': datetime.now().isoformat()
    })


if __name__ == '__main__':
    port = int(os.getenv('PORT', 3000))
    print(f"🚀 Backend server starting on http://localhost:{port}")
    app.run(host='0.0.0.0', port=port, debug=True, threaded=True)
