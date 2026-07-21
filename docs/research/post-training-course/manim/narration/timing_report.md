# Narration timing report

The core narration contains 3,300 spoken words across the 26:08.404 visual course. OpenAI Speech generated content-addressed narration beats with the pinned `gpt-4o-mini-tts-2025-12-15` model, Cedar voice, and speed `1.10`.

Each raw response is preserved. Speech remains at its generated cadence: no global tempo stretch is applied. Silence is inserted between one- or two-sentence concepts, with a 0.7-second chapter lead-in and tail. Chapter-level normalization plus 2 dB of final gain produces a louder mix without clipping.

| Chapter | Beats | Words | Speech | Pause per beat | Final window |
| --- | ---: | ---: | ---: | ---: | ---: |
| Choose, judge, update | 6 | 138 | 55.01 s | 1.71 s | 64.97 s |
| Definitions | 29 | 847 | 341.30 s | 1.13 s | 374.37 s |
| On/off-policy data source | 7 | 126 | 55.42 s | 1.59 s | 66.37 s |
| Trajectories, signals, and credit | 16 | 376 | 152.52 s | 1.73 s | 179.83 s |
| RLVR and verifiers | 17 | 386 | 152.57 s | 1.16 s | 172.53 s |
| PPO and GRPO | 16 | 387 | 148.99 s | 1.55 s | 173.60 s |
| Distillation | 13 | 290 | 119.97 s | 3.36 s | 161.67 s |
| OPSD, SDFT, and SDPO | 15 | 333 | 141.71 s | 1.43 s | 163.13 s |
| Research design | 17 | 417 | 188.31 s | 1.39 s | 211.93 s |

## Advanced appendix

The optional appendix contains 359 spoken words across 3:11.767 of visual material.

| Appendix | Beats | Words | Speech | Pause per beat | Final window |
| --- | ---: | ---: | ---: | ---: | ---: |
| GRPO normalization and diversity | 5 | 94 | 41.42 s | 4.50 s | 60.80 s |
| Distillation storage | 3 | 58 | 23.86 s | 3.42 s | 32.10 s |
| Paper results and SRPO | 9 | 207 | 82.60 s | 1.86 s | 98.87 s |

## Media validation

- Core narrated MP4 duration: `1568.404` seconds.
- Appendix narrated MP4 duration: `191.767` seconds.
- Video: H.264, 1280×720, 30 fps.
- Audio: AAC, 48 kHz, stereo, 192 kb/s target.
- Lossless narration master: PCM WAV, 48 kHz, stereo.
- Mean full-track level including silence: `−16.5 dB` for the core and `−16.8 dB` for the appendix.
- Peak full-track level: `−2.0 dB` for both the core and appendix.
- Opening silence: approximately `0.73` seconds for the core and `0.74` seconds for the appendix.
- Audio-stream label: `AI-generated narration`.
- Full audio/video decode: passed.
