# Narration timing report

The core narration contains 3,091 spoken words across the 24:06.171 visual course. OpenAI Speech generated content-addressed narration beats with the pinned `gpt-4o-mini-tts-2025-12-15` model, Cedar voice, and speed `1.10`.

Each raw response is preserved. Speech remains at its generated cadence: no global tempo stretch is applied. Silence is inserted between one- or two-sentence concepts, with a 0.7-second chapter lead-in and tail. Chapter-level normalization plus 2 dB of final gain produces a louder mix without clipping.

| Chapter | Beats | Words | Speech | Pause per beat | Final window |
| --- | ---: | ---: | ---: | ---: | ---: |
| Choose, judge, update | 6 | 138 | 55.01 s | 2.58 s | 69.33 s |
| Definitions | 22 | 638 | 263.30 s | 0.76 s | 280.67 s |
| On/off-policy data source | 7 | 126 | 55.42 s | 0.81 s | 61.67 s |
| Trajectories, signals, and credit | 16 | 376 | 152.52 s | 1.41 s | 175.13 s |
| RLVR and verifiers | 17 | 386 | 152.57 s | 0.87 s | 167.83 s |
| PPO and GRPO | 16 | 387 | 148.99 s | 1.23 s | 168.90 s |
| Distillation | 13 | 290 | 119.97 s | 2.97 s | 156.97 s |
| OPSD, SDFT, and SDPO | 15 | 333 | 141.71 s | 1.09 s | 158.43 s |
| Research design | 17 | 417 | 188.31 s | 1.10 s | 207.23 s |

## Advanced appendix

The optional appendix contains 359 spoken words across 3:07.067 of visual material.

| Appendix | Beats | Words | Speech | Pause per beat | Final window |
| --- | ---: | ---: | ---: | ---: | ---: |
| GRPO normalization and diversity | 5 | 94 | 41.42 s | 3.32 s | 56.10 s |
| Distillation storage | 3 | 58 | 23.86 s | 3.42 s | 32.10 s |
| Paper results and SRPO | 9 | 207 | 82.60 s | 1.86 s | 98.87 s |

## Media validation

- Core narrated MP4 duration: `1446.171` seconds.
- Appendix narrated MP4 duration: `187.067` seconds.
- Video: H.264, 1280×720, 30 fps.
- Audio: AAC, 48 kHz, stereo, 192 kb/s target.
- Lossless narration master: PCM WAV, 48 kHz, stereo.
- Mean full-track level including silence: `−16.5 dB` for the core and `−16.8 dB` for the appendix.
- Peak full-track level: `−2.0 dB` for both the core and appendix.
- Opening silence: approximately `0.73` seconds for the core and `0.74` seconds for the appendix.
- Audio-stream label: `AI-generated narration`.
- Full audio/video decode: passed.
