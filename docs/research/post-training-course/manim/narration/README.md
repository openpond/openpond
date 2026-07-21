# Narration pipeline

This directory contains the reproducible OpenAI Speech API pipeline for the course.

## Stored artifacts

- `../narration_script.md` — canonical recording script.
- `manifest.json` — pinned model, voice, delivery instructions, and exact chapter durations.
- `../appendix_narration_script.md` and `appendix_manifest.json` — corresponding appendix inputs.
- `raw/segments/` — original lossless Speech API responses for each narration beat.
- `fitted/` — louder normalized chapter audio with silence inserted between concepts.
- `full_narration.wav` — concatenated narration track.
- `appendix_full_narration.wav` — concatenated appendix narration track.
- `../videos/PostTrainingFromFirstPrinciplesNarrated.mp4` — video with the narration track.
- `../videos/PostTrainingAdvancedAppendixNarrated.mp4` — narrated optional appendix.

The generated voice is identified in the final audio-stream metadata without adding an outro card to the lesson content.

## Generate

From the OpenPond repository root:

```bash
node docs/research/post-training-course/manim/narration/generate.mjs \
  --env-file ../sandbox/.env.staging \
  --sample
```

After reviewing `narration/sample-cedar.wav`, generate and mix the full course:

```bash
node docs/research/post-training-course/manim/narration/generate.mjs \
  --env-file ../sandbox/.env.staging \
  --all
```

Generate the appendix with its separate manifest:

```bash
node docs/research/post-training-course/manim/narration/generate.mjs \
  --manifest appendix_manifest.json \
  --env-file ../sandbox/.env.staging \
  --all
```

The environment file is read only to obtain `OPENAI_API_KEY`. Its contents are never copied or printed.

Existing raw OpenAI WAV responses are content-addressed and reused by default, so timing, loudness, and mux changes do not make new API calls. Add `--force` only when intentionally regenerating the voice.
