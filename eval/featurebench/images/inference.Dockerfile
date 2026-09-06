ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG FEATUREBENCH_REVISION=3a19b110a39a13f5cd000472a2209f112219af64
ARG MINI_SWE_AGENT_VERSION=2.4.6

RUN python3 -m venv /opt/kona-eval-venv \
    && /opt/kona-eval-venv/bin/pip install --no-cache-dir --ignore-requires-python \
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
