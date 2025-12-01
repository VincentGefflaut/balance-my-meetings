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
previous_diarization = []
speaker_mapping = {}
consistent_speaker_times = {}
custom_speaker_names = {}
audio_lock = threading.Lock()


def calculate_segment_overlap(seg1, seg2):
    """Calculate overlap duration between two segments."""
    start = max(seg1['start'], seg2['start'])
    end = min(seg1['end'], seg2['end'])
    return max(0, end - start)


def find_best_speaker_mapping(new_diarization, prev_diarization):
    """
    Find the best mapping from new speaker labels to previous speaker labels
    by comparing segment overlaps.
    """
    if not prev_diarization:
        # First iteration - create initial mapping
        mapping = {}
        seen_speakers = set()

        for item in new_diarization:
            speaker = item['speaker']
            if speaker not in seen_speakers:
                mapping[speaker] = f"SPEAKER_{len(mapping):02d}"
                seen_speakers.add(speaker)

        return mapping

    # Group segments by speaker
    new_speakers = {}
    prev_speakers = {}

    for item in new_diarization:
        speaker = item['speaker']
        if speaker not in new_speakers:
            new_speakers[speaker] = []
        new_speakers[speaker].append(item)

    for item in prev_diarization:
        speaker = item['speaker']
        if speaker not in prev_speakers:
            prev_speakers[speaker] = []
        prev_speakers[speaker].append(item)

    # Calculate overlap scores
    mapping = {}
    used_prev_speakers = set()

    for new_speaker in new_speakers:
        best_match = None
        best_overlap = 0

        for prev_speaker in prev_speakers:
            if prev_speaker in used_prev_speakers:
                continue

            total_overlap = 0
            for new_seg in new_speakers[new_speaker]:
                for prev_seg in prev_speakers[prev_speaker]:
                    total_overlap += calculate_segment_overlap(new_seg, prev_seg)

            if total_overlap > best_overlap:
                best_overlap = total_overlap
                best_match = prev_speaker

        if best_match and best_overlap > 0:
            mapping[new_speaker] = best_match
            used_prev_speakers.add(best_match)
        else:
            # Assign new consistent ID
            new_id = f"SPEAKER_{len(consistent_speaker_times):02d}"
            mapping[new_speaker] = new_id

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


def start_diarization_job(object_key, webhook_url=None):
    """Start diarization job on Pyannote API."""
    payload = {'url': f'media://{object_key}'}

    if webhook_url:
        payload['webhook'] = webhook_url

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
    """Process diarization results and update speaker times."""
    global speaker_mapping, consistent_speaker_times, previous_diarization

    # Find speaker mapping
    speaker_mapping = find_best_speaker_mapping(new_diarization, previous_diarization)

    # Recalculate speaking times
    temp_speaker_times = {}
    for item in new_diarization:
        original_speaker = item['speaker']
        consistent_speaker = speaker_mapping[original_speaker]
        duration = item['end'] - item['start']

        if consistent_speaker not in temp_speaker_times:
            temp_speaker_times[consistent_speaker] = 0
        temp_speaker_times[consistent_speaker] += duration

    consistent_speaker_times = temp_speaker_times

    # Update previous diarization with consistent labels
    previous_diarization = []
    for item in new_diarization:
        mapped_item = item.copy()
        mapped_item['speaker'] = speaker_mapping[item['speaker']]
        previous_diarization.append(mapped_item)

    print(f"Updated speaker times: {consistent_speaker_times}")


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
        with audio_lock:
            if not audio_buffer:
                return jsonify({
                    'success': False,
                    'message': 'No audio to process'
                })

            # Concatenate all audio chunks
            full_audio = b''.join(audio_buffer)

        # Upload to Pyannote
        object_key = upload_audio_to_pyannote(full_audio)

        # Start diarization job
        job_data = start_diarization_job(object_key)
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

    for speaker_id, time_value in consistent_speaker_times.items():
        speakers.append({
            'id': speaker_id,
            'name': custom_speaker_names.get(speaker_id, speaker_id),
            'time': time_value
        })

    total_time = sum(s['time'] for s in speakers)

    # Return timeline segments with consistent speaker labels
    timeline_segments = [{
        'speaker': seg['speaker'],
        'start': seg['start'],
        'end': seg['end']
    } for seg in previous_diarization]

    return jsonify({
        'speakers': speakers,
        'totalTime': total_time,
        'timeline': timeline_segments
    })


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
    global audio_buffer, previous_diarization, speaker_mapping
    global consistent_speaker_times, custom_speaker_names

    with audio_lock:
        audio_buffer = []

    previous_diarization = []
    speaker_mapping = {}
    consistent_speaker_times = {}
    custom_speaker_names = {}

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
