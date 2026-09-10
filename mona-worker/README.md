# Mona Worker

Mona Worker runs attachment processing on the always-on notebook. It is deployed with Docker Compose under `/opt/mona-worker`. The authoritative notebook deployment record is `docs/architecture/mona-worker-notebook-deployment.md`.

The deployed services are `mona-asr`, `mona-ocr`, `mona-structure-ocr`, and `mona-worker-api`. They are internal-only: ASR provides SenseVoiceSmall transcription with VAD, punctuation, and anonymous speaker labels; OCR provides PP-OCRv5 mobile image/page recognition; Structure OCR provides PP-StructureV3 layout and table parsing.

Run it on the notebook with:

```sh
DOCKER_HOST=unix:///var/run/docker.sock \
  /opt/mona-worker/docker/bin/docker-compose \
  -f /opt/mona-worker/compose.yaml up -d --build mona-asr mona-ocr mona-structure-ocr mona-worker-api
```




`mona-worker-api` is the only container that contacts the VPS. Before starting it, create `/opt/mona-worker/.env` from `config/worker-api.env.example` using a provisioned Worker key. The model containers remain private to the Compose network.

