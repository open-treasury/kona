import base64
import hashlib
import importlib
import json
import os


def handler(event, _context):
    boto3 = importlib.import_module("boto3")
    message = base64.b64decode(event["message"])
    authorization = json.loads(message)
    for field in ("runId", "epochSha256", "requestedConcurrency"):
        if authorization[field] != event[field]:
            raise ValueError(f"signed {field} mismatch")
    digest = hashlib.sha256(message).digest()
    verified = boto3.client("kms").verify(
        KeyId=os.environ["SIGNING_KEY_ARN"],
        Message=digest,
        MessageType="DIGEST",
        Signature=base64.b64decode(event["signature"]),
        SigningAlgorithm="RSASSA_PSS_SHA_256",
    )
    if not verified["SignatureValid"]:
        raise ValueError("invalid probe signature")
    manifest = boto3.client("s3").get_object(
        Bucket=authorization["manifestBucket"], Key=authorization["manifestKey"]
    )
    body = manifest["Body"].read()
    if hashlib.sha256(body).hexdigest() != authorization["manifestSha256"]:
        raise ValueError("continuation manifest hash mismatch")
    return {"authorization": authorization, "manifestVersionId": manifest["VersionId"]}
