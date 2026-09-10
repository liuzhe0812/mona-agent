FROM python:3.11-slim

ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r /tmp/requirements.txt

RUN useradd --system --uid 995 --create-home --home-dir /app mona-worker
WORKDIR /app
COPY --chown=mona-worker:mona-worker app ./app
USER mona-worker

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
