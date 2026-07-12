from pathlib import Path
import hashlib
import json

from openpond_training.contracts import sha256_bytes
from openpond_training.fixture_model import construct_fixture


def test_sha256_is_stable() -> None:
    assert sha256_bytes(b"openpond") == "0a24885f710a52868e03bd25a44f14f188518ff773f79bc2281a9b9a95cf1da2"


def test_worker_package_has_no_downloaded_model_fixture() -> None:
    package = Path(__file__).parents[1] / "src" / "openpond_training"
    assert not any(path.suffix in {".bin", ".safetensors"} for path in package.rglob("*"))


def test_tokenizer_and_chat_template_match_checked_in_golden_fixture() -> None:
    fixture_path = Path(__file__).parents[1] / "src" / "openpond_training" / "fixtures" / "golden.json"
    golden = json.loads(fixture_path.read_text())
    _, tokenizer, template_hash = construct_fixture([golden["record"]], golden["seed"])
    tokenizer_hash = hashlib.sha256(tokenizer.backend_tokenizer.to_str().encode()).hexdigest()
    assert tokenizer_hash == golden["tokenizerHash"]
    assert template_hash == golden["chatTemplateHash"]
