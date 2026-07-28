from __future__ import annotations

from openpond_training.canonical_json import canonical_json, content_hash


def test_matches_typescript_number_and_structure_serialization() -> None:
    value = {
        "learningRate": 0.00005,
        "nested": {
            "negativeZero": -0.0,
            "threshold": 0.8,
        },
        "values": [1, 0.000001, 1e-7, 1e21],
    }

    assert canonical_json(value) == (
        "{\n"
        '  "learningRate": 0.00005,\n'
        '  "nested": {\n'
        '    "negativeZero": 0,\n'
        '    "threshold": 0.8\n'
        "  },\n"
        '  "values": [\n'
        "    1,\n"
        "    0.000001,\n"
        "    1e-7,\n"
        "    1e+21\n"
        "  ]\n"
        "}\n"
    )
    assert content_hash(value) == (
        "6fcf55024c1a5186eef9d5d744323cb057ef18fc95d863c9dbb687c48d674d85"
    )
