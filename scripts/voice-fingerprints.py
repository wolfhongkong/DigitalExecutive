import contextlib
import json
import math
import os
import sys
import wave
from array import array
from pathlib import Path


def sample_ranges(start, end):
    duration = min(12, end - start)
    count = min(3, math.ceil((end - start) / 12))
    return [(start + (end - start - duration) * position / max(1, count - 1), duration)
            for position in range(count)]


def combine_embeddings(vectors):
    if not vectors:
        return None
    similarities = [[sum(first * second for first, second in zip(vector, other))
                     for other in vectors] for vector in vectors]
    reference = max(range(len(vectors)), key=lambda index: sum(similarities[index]))
    accepted = [vector for index, vector in enumerate(vectors) if similarities[reference][index] >= 0.45]
    if len(vectors) > 1 and len(accepted) <= len(vectors) / 2:
        return None
    mean = [sum(values) for values in zip(*accepted)]
    norm = math.sqrt(sum(value * value for value in mean))
    return [value / norm for value in mean] if norm > 1e-8 else None


def extract(audio_path, manifest_path):
    import torch
    from speechbrain.inference.classifiers import EncoderClassifier
    from silero_vad import get_speech_timestamps, load_silero_vad

    torch.set_num_threads(2)
    detector = load_silero_vad()
    cache = Path(os.environ.get("VOICE_FINGERPRINT_MODEL_DIR", Path.home() / ".cache" / "ultimate-executive" / "ecapa"))
    encoder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(cache),
        run_opts={"device": "cpu"},
    )
    with open(manifest_path, encoding="utf-8") as manifest:
        turns = json.load(manifest)
    entries = []
    with wave.open(str(audio_path), "rb") as audio:
        if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("Expected mono 16 kHz PCM16 audio")
        for turn in turns:
            vectors = []
            for start, duration in sample_ranges(turn["start"], turn["end"]):
                offset = round(start * 16000)
                count = round(duration * 16000)
                if offset < 0 or offset + count > audio.getnframes():
                    raise ValueError("Speech timestamp exceeds decoded audio")
                audio.setpos(offset)
                samples = array("h", audio.readframes(count))
                if sys.byteorder != "little":
                    samples.byteswap()
                signal = torch.tensor(samples, dtype=torch.float32) / 32768
                if count < 32000 or signal.square().mean().sqrt().item() < 0.005:
                    continue
                spans = get_speech_timestamps(signal, detector, sampling_rate=16000,
                                              min_speech_duration_ms=250, min_silence_duration_ms=150)
                if not spans:
                    continue
                speech = torch.cat([signal[span["start"]:span["end"]] for span in spans])[:128000]
                if speech.numel() < 32000:
                    continue
                with torch.inference_mode():
                    vector = encoder.encode_batch(speech.unsqueeze(0)).reshape(-1)
                    if vector.numel() != 192 or not torch.isfinite(vector).all() or vector.norm().item() < 1e-8:
                        raise ValueError("Model returned an invalid speaker embedding")
                    vectors.append((vector / vector.norm()).tolist())
            entries.append({"index": turn["index"], "embedding": combine_embeddings(vectors)})
    return entries


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            output = extract(Path(sys.argv[1]), Path(sys.argv[2]))
        json.dump(output, sys.stdout, allow_nan=False)
    except Exception as error:
        print(f"Voice fingerprint worker failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)