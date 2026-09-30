#!/usr/bin/env python3
"""Generate webhook signature test vectors with Odoo's own ``odoo.tools.misc.hmac``.

Odoo verifies the completion postback (``ai/controllers/thread.py``) with that function, using the
scope ``"odoo_ai-webhook"``, the message ``(request_uuid, llm_result, llm_error)`` and the webhook
secret of the request as key. It computes
``hmac.new(secret.encode(), repr((scope, message)).encode(), sha256).hexdigest()`` on the values
``json.loads`` produced from the body the gateway posted.

Each vector below is a JSON document *as the gateway serialises it* (``JSON.stringify`` output),
so Python parses exactly the text Odoo would receive.

Usage (from the repository root)::

    ODOO_PATH=./odoo PY_NEWEST=python3.14 python3.12 scripts/gen_signature_vectors.py > test/fixtures/signature-vectors.json

When ``ODOO_PATH`` points to an Odoo checkout whose dependencies are importable, the real
``odoo.tools.misc.hmac`` is used; otherwise the formula above is computed directly and the fixture
says so in ``implementation``.
"""
import hashlib
import hmac as hmac_lib
import json
import os
import sys

SCOPE = "odoo_ai-webhook"


def _load_odoo_hmac():
    odoo_path = os.environ.get("ODOO_PATH")
    if not odoo_path:
        return None, "formula"
    sys.path.insert(0, os.path.abspath(odoo_path))
    try:
        from odoo.tools.misc import hmac as odoo_hmac  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        print(f"warning: cannot import odoo.tools.misc.hmac ({exc}); using the formula", file=sys.stderr)
        return None, "formula"
    return odoo_hmac, "odoo.tools.misc.hmac"


def _formula_hmac(_env, scope, message, *, secret):
    """The formula from the module docstring, callable like ``odoo.tools.misc.hmac``."""
    return hmac_lib.new(secret.encode(), repr((scope, message)).encode(), hashlib.sha256).hexdigest()


# (name, request_uuid, llm_result JSON text, llm_error JSON text, secret)
# The JSON texts must be canonical JSON.stringify output (checked by the TypeScript test).
CASES = [
    ("success_text", "3f2b8a1e-5c4d-4e7f-9a0b-1c2d3e4f5a6b",
     '{"status":"success","result":{"role":"assistant","content":[{"type":"text","text":"Hello, world!"}],"provider_metadata":{}}}',
     'false', "test-webhook-secret"),
    ("odoo_test_shape_no_status", "uuid-1",
     '{"result":{"role":"assistant","content":[{"type":"text","text":"Test conversation"}],"provider_metadata":{}}}',
     'false', "secret"),
    ("tool_call", "0b9f7c1a-2222-4444-8888-aaaaaaaaaaaa",
     '{"status":"success","result":{"role":"assistant","content":[{"type":"tool_call","call_id":"call_abc","name":"search_partners","args":{"query":"Azure","state":"draft","ids":[1,2,3],"limit":10,"ratio":0.5,"flag":true,"none":null}}],"provider_metadata":{"provider":"openai","model":"gpt-5-mini"}}}',
     'false', "another-test-secret"),
    ("failure", "fail-uuid",
     'false',
     '"Provider error: 500 Internal Server Error"', "abc"),
    ("quotes_and_escapes", "q",
     '{"a":"it\'s","b":"say \\"hi\\"","c":"both \' and \\"","d":"back\\\\slash","e":"line\\nbreak\\ttab\\rcr","f":""}',
     'false', "k"),
    ("control_chars", "c",
     '{"nul":"\\u0000","us":"\\u001f","del":"\u007f","bell":"\\u0007","esc":"\\u001b"}',
     'false', "k"),
    ("unicode_printable", "u",
     '{"latin":"caf\u00e9 \u00f1and\u00fa","cjk":"\u4e2d\u6587","emoji":"\U0001F389\U0001F680","greek":"\u03a9","rtl":"\u05e9\u05dc\u05d5\u05dd"}',
     'false', "k"),
    ("unicode_non_printable", "n",
     '{"nbsp":"a\u00a0b","zwsp":"\u200b","ls":"\u2028","ps":"\u2029","bom":"\ufeff","pua":"\ue000","soft_hyphen":"\u00ad","c1":"\u0085","unassigned":"\u0378","plane16":"\U0010FFFF","tag":"\U000E0001","ideographic_space":"\u3000"}',
     'false', "k"),
    ("numbers", "num",
     '{"zero":0,"neg":-5,"int":1234567890,"big_int":123456789012345680000,"f1":0.1,"f2":1.5,"f3":-0.5,"f4":123.456,"small":0.0001,"smaller":0.00001,"tiny":1e-7,"e15":1000000000000000,"e16":10000000000000000,"e21":1e+21,"huge":1.5e+300,"pi":3.141592653589793,"third":0.3333333333333333,"f_e22":1.2345e+22,"neg_small":-2.5e-8}',
     'false', "k"),
    ("nested_and_empty", "nest",
     '{"list":[],"dict":{},"nested":[[1,[2,[3]]],{"a":{"b":{"c":[true,false,null]}}}],"single":[1],"mixed":[1,"two",3.5,null,true,{"k":"v"}]}',
     'false', "k"),
    ("key_order_integer_like", "order",
     '{"1":"one","2":"two","10":"ten","b":"bee","a":"ay","-1":"neg"}',
     'false', "k"),
    ("inline_data_image", "img",
     '{"status":"success","result":{"role":"assistant","content":[{"type":"text","text":"Here is your image"},{"type":"inline_data","mimetype":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}],"provider_metadata":{}}}',
     'false', "k"),
    ("web_sources", "web",
     '{"status":"success","result":{"role":"assistant","content":[{"type":"text","text":"Odoo is an ERP [WEB_SOURCE:a1b2c3d4e5].","sources":{"a1b2c3d4e5":{"url":"https://www.odoo.com/","source_name":"odoo.com"}}}],"provider_metadata":{}}}',
     'false', "k"),
    ("unicode_secret", "sec",
     '{"result":{"role":"assistant","content":[],"provider_metadata":{}}}',
     'false', "s\u00e9cr\u00e8t-\U0001F511"),
    ("error_with_quotes_and_unicode", "err",
     'false',
     '"Claude API error 400: \\"messages.0\\" isn\'t valid \u2014 d\u00e9tails\\n"', "k"),
    ("null_error", "nullerr",
     '{"result":{"role":"assistant","content":[{"type":"text","text":"ok"}],"provider_metadata":{}}}',
     'null', "k"),
]


# Payloads the gateway must SANITIZE before signing: (name, request_uuid, raw JSON as produced
# by a provider, JSON actually sent after sanitizing, secret). Characters assigned after Unicode
# 15.0 are printable on Python 3.13/3.14 but escaped by repr() on 3.12, NUL and lone surrogates
# break PostgreSQL jsonb: all become U+FFFD so every supported Odoo Python agrees.
SANITIZE_CASES = [
    ("sanitize_unicode_16_emoji", "s1",
     '{"result":{"role":"assistant","content":[{"type":"text","text":"Tired \\ud83e\\udee9 face, fingerprint \\ud83e\\udec6"}],"provider_metadata":{}}}',
     '{"result":{"role":"assistant","content":[{"type":"text","text":"Tired \ufffd face, fingerprint \ufffd"}],"provider_metadata":{}}}',
     "k"),
    ("sanitize_cjk_ext_i_unicode_15_1", "s2",
     '{"result":{"role":"assistant","content":[{"type":"text","text":"\\ud87a\\udff0 ok \u4e2d"}],"provider_metadata":{}}}',
     '{"result":{"role":"assistant","content":[{"type":"text","text":"\ufffd ok \u4e2d"}],"provider_metadata":{}}}',
     "k"),
    ("sanitize_nul_and_lone_surrogate", "s3",
     '{"result":{"role":"assistant","content":[{"type":"tool_call","name":"t","args":{"q":"a\\u0000b\\ud800c"},"call_id":"1"}],"provider_metadata":{}}}',
     '{"result":{"role":"assistant","content":[{"type":"tool_call","name":"t","args":{"q":"a\ufffdb\ufffdc"},"call_id":"1"}],"provider_metadata":{}}}',
     "k"),
]


def _newest_signatures(entries):
    """Recompute signatures with the newest supported Python (PY_NEWEST) to prove they agree."""
    newest = os.environ.get("PY_NEWEST")
    if not newest:
        return None, None
    import subprocess  # noqa: PLC0415
    code = (
        "import hashlib,hmac,json,sys\n"
        "out=[]\n"
        "for e in json.load(sys.stdin):\n"
        "    msg=(e['uuid'], json.loads(e['result']), json.loads(e['error']))\n"
        "    out.append(hmac.new(e['secret'].encode(), repr(('odoo_ai-webhook', msg)).encode(), hashlib.sha256).hexdigest())\n"
        "print(json.dumps({'python': sys.version.split()[0], 'signatures': out}))\n"
    )
    result = subprocess.run([os.path.expanduser(newest), "-c", code], input=json.dumps(entries), capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    return data["python"], data["signatures"]


def main():
    odoo_hmac, implementation = _load_odoo_hmac()
    sign = odoo_hmac or _formula_hmac
    vectors = []
    for name, request_uuid, result_text, error_text, secret in CASES:
        llm_result = json.loads(result_text)
        llm_error = json.loads(error_text)
        message = (request_uuid, llm_result, llm_error)
        vectors.append({
            "name": name,
            "secret": secret,
            "request_uuid": request_uuid,
            "llm_result_json": result_text,
            "llm_error_json": error_text,
            "python_repr": repr((SCOPE, message)),
            "signature": sign(None, SCOPE, message, secret=secret),
        })
    sanitize_vectors = []
    for name, request_uuid, raw_text, sent_text, secret in SANITIZE_CASES:
        sent = json.loads(sent_text)
        message = (request_uuid, sent, False)
        sanitize_vectors.append({
            "name": name,
            "secret": secret,
            "request_uuid": request_uuid,
            "raw_llm_result_json": raw_text,
            "sent_llm_result_json": sent_text,
            "python_repr": repr((SCOPE, message)),
            "signature": sign(None, SCOPE, message, secret=secret),
        })

    entries = [{"uuid": v["request_uuid"], "result": v["llm_result_json"], "error": v["llm_error_json"], "secret": v["secret"]} for v in vectors]
    entries += [{"uuid": v["request_uuid"], "result": v["sent_llm_result_json"], "error": "false", "secret": v["secret"]} for v in sanitize_vectors]
    newest_python, newest_signatures = _newest_signatures(entries)
    verified_with = [sys.version.split()[0]]
    if newest_signatures is not None:
        expected = [v["signature"] for v in vectors] + [v["signature"] for v in sanitize_vectors]
        mismatches = [i for i, (a, b) in enumerate(zip(expected, newest_signatures)) if a != b]
        # Plain vectors with post-15.0 characters would legitimately differ; the sanitized ones must not.
        bad = [i for i in mismatches if i >= len(vectors)]
        if bad:
            sys.exit(f"sanitized vectors differ on Python {newest_python}: {bad}")
        if mismatches:
            print(f"note: {len(mismatches)} raw vectors differ on Python {newest_python}", file=sys.stderr)
        verified_with.append(newest_python)

    json.dump({
        "generator": "scripts/gen_signature_vectors.py",
        "implementation": implementation,
        "python": sys.version.split()[0],
        "verified_with": verified_with,
        "scope": SCOPE,
        "vectors": vectors,
        "sanitize_vectors": sanitize_vectors,
    }, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
