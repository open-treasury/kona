ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG FEATUREBENCH_REVISION=3a19b110a39a13f5cd000472a2209f112219af64
ARG MINI_SWE_AGENT_VERSION=2.4.6

RUN sed -i 's|http://mirrors.aliyun.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list \
    && apt-get update \
    && apt-get install --yes --no-install-recommends tmux asciinema \
    && rm -rf /var/lib/apt/lists/* \
    && /opt/miniconda3/bin/conda create --yes --prefix /opt/kona-eval-venv python=3.12.11 pip \
    && /opt/kona-eval-venv/bin/pip install --no-cache-dir \
      "numpy==2.2.6" \
      "scipy==1.16.3" \
      "featurebench @ git+https://github.com/LiberCoders/FeatureBench.git@${FEATUREBENCH_REVISION}" \
      "mini-swe-agent==${MINI_SWE_AGENT_VERSION}" \
      boto3 \
    && ln -sfn /opt/kona-eval-venv /opt/mini-swe-agent-venv

COPY eval/featurebench/runtime/common.py /opt/kona-eval/common.py
COPY eval/featurebench/runtime/infer.py /opt/kona-eval/infer.py
COPY eval/featurebench/runtime/worker.py /opt/kona-eval/worker.py

ENV PYTHONPATH=/opt/kona-eval
ENTRYPOINT ["/opt/kona-eval-venv/bin/python", "/opt/kona-eval/worker.py"]
