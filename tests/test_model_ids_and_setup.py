"""Regressions from the fork merge (PR #6 provider-qualified model ids,
PR #7 account/tunnel auto-detection).

Offline only: no Telegram, no aside CLI, no real ~/.aside. Every path
these touch is a temp directory, and every side-effecting bridge function
is stubbed the way the other suites here stub them.

Run:  python3 tests/test_model_ids_and_setup.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

fails = []


def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        fails.append(name)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---- a throwaway config.json, only if there is not one already --------
# bridge.py resolves its config next to itself and exits without one, so
# a checkout with no config (a fresh clone, CI) gets a fixture for the
# length of this run and gets it removed afterwards.
CONFIG_PATH = os.path.join(HERE, "config.json")
FIXTURE_ROOT = tempfile.mkdtemp(prefix="bridge-test-")
MADE_CONFIG = not os.path.exists(CONFIG_PATH)
if MADE_CONFIG:
    os.makedirs(os.path.join(FIXTURE_ROOT, "sessions"), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump({
            "token": "1234567890:TEST-ONLY-FAKE-BOT-TOKEN-not-real",
            "chat_id": 8675309,
            "owner_name": "Fixture",
            "default_model": "",
            "default_effort": "medium",
            "aside_cli": "/bin/echo",
            "sessions_dir": os.path.join(FIXTURE_ROOT, "sessions"),
            "credentials_path": os.path.join(FIXTURE_ROOT, "credentials.json"),
            "style": "formal",
        }, f)

try:
    b = load("bridgemod", os.path.join(HERE, "bridge.py"))
    setup = load("setupmod", os.path.join(HERE, "setup.py"))
    miniapp_setup = load(
        "miniappsetupmod", os.path.join(HERE, "miniapp", "setup-miniapp.py"))
finally:
    if MADE_CONFIG:
        os.unlink(CONFIG_PATH)

# ---- stub every side effect ------------------------------------------
TEXTS = []
b.send_text = lambda t: TEXTS.append(t)
b.send_bubbles = lambda t: TEXTS.append(t)
b.tg = lambda m, p=None, timeout=65: {"ok": True, "result": {}}
b.tg_send_status = lambda t: None
b.save_json = lambda *a, **k: None
b.log = lambda *a, **k: None


# ---- 1. a partial map overrides an entry, not the whole map ----------
print("\nmerged model maps")

DEFAULTS = {"a": "1", "b": "2", "c": "3"}
saved_config = b.CONFIG
try:
    b.CONFIG = {"m": {"b": "OVERRIDE"}}
    merged = b.merged_map("m", DEFAULTS)
    check("a one-key override keeps the other defaults",
          merged == {"a": "1", "b": "OVERRIDE", "c": "3"})

    b.CONFIG = {}
    check("no override at all is just the defaults",
          b.merged_map("m", DEFAULTS) == DEFAULTS)

    b.CONFIG = {"m": "not-a-dict"}
    check("a junk override is ignored rather than crashing",
          b.merged_map("m", DEFAULTS) == DEFAULTS)

    b.CONFIG = {"m": {"d": "4"}}
    check("an unknown key is added, not swapped in",
          b.merged_map("m", DEFAULTS)["a"] == "1"
          and b.merged_map("m", DEFAULTS)["d"] == "4")
finally:
    b.CONFIG = saved_config

# The shipped example config is exactly the partial map that used to be
# destructive, so it is the case worth pinning against the real file.
with open(os.path.join(HERE, "config.example.json")) as f:
    example = json.load(f)
check("config.example.json ships a PARTIAL model_ids map",
      0 < len(example.get("model_ids") or {}) < len(b.MODEL_IDS))
check("every built-in model id survives that example",
      all(k in b.MODEL_IDS for k in
          ("claude-opus-5", "gpt-5.6", "gpt-5.4-mini")))
check("the example's own entries are provider-qualified",
      all("/" in v for v in (example.get("model_ids") or {}).values()))
check("every model_aliases target has a qualified id",
      all(target in b.MODEL_IDS for target in b.MODEL_ALIASES.values()))


# ---- 2. the failure hint names a command this install accepts --------
print("\nthe /model hint")

saved_aliases = b.MODEL_ALIASES
try:
    b.MODEL_ALIASES = {"sonnet": "claude-sonnet-5", "opus": "claude-opus-4-8"}
    check("prefers sonnet when the install has it",
          b.model_switch_hint() == "/model sonnet")

    # The bug: the hint was the literal string "/model sonnet", so an
    # install that renamed its aliases was told to type something that
    # would be read as a raw model id.
    b.MODEL_ALIASES = {"zippy": "gpt-5.4-mini"}
    check("names a configured alias when sonnet is not one",
          b.model_switch_hint() == "/model zippy")

    b.MODEL_ALIASES = {}
    check("falls back to a real model id when there are no aliases",
          b.model_switch_hint().startswith("/model ")
          and b.model_switch_hint() != "/model sonnet")
finally:
    b.MODEL_ALIASES = saved_aliases


# ---- 3. -m is provider-qualified before it reaches the CLI -----------
print("\nrun_aside qualifies the model")

CALLS = []


class FakeProc(object):
    returncode = 0
    stdout = "ok"
    stderr = ""


saved_run = b.subprocess.run
try:
    b.subprocess.run = lambda cmd, **kw: (CALLS.append(cmd), FakeProc())[1]
    b.run_aside("hi", model="claude-sonnet-5")
    check("a bare id is sent qualified",
          "claude-code/claude-sonnet-5" in CALLS[-1])
    CALLS.clear()
    b.run_aside("hi", model="who/knows")
    check("an unknown id is passed through untouched",
          "who/knows" in CALLS[-1])
    CALLS.clear()
    b.run_aside("hi", model="")
    check("an empty model omits -m entirely", "-m" not in CALLS[-1])
finally:
    b.subprocess.run = saved_run


# ---- 4. a transcript with bad bytes does not take the poller down ----
print("\ntranscript reads survive bad bytes")

tmp = tempfile.mkdtemp(prefix="bridge-jsonl-")
try:
    torn = os.path.join(tmp, "messages.jsonl")
    good = json.dumps({"role": "assistant", "stopReason": "error",
                       "errorMessage": "429 status code"})
    with open(torn, "wb") as f:
        # A line cut mid-character, exactly what reading a file another
        # process is appending to produces. Strict decoding raised
        # UnicodeDecodeError out of the LINE ITERATOR -- not an OSError,
        # so nothing caught it.
        f.write(b'{"role":"assistant","content":[{"type":"text",'
                b'"text":"caf\xc3"}]}\n')
        f.write(good.encode("utf-8") + b"\n")

    check("read_error_since still finds the error after a torn line",
          b.read_error_since(torn, 0) == "429 status code")
    check("read_assistant_since does not raise on it",
          isinstance(b.read_assistant_since(torn, 0), str))
    check("_session_preview does not raise on it",
          isinstance(b._session_preview(torn), tuple))

    check("strict=False still reports an unreadable file as no error",
          b.read_error_since(os.path.join(tmp, "gone.jsonl"), 0) == "")
    raised = False
    try:
        b.read_error_since(os.path.join(tmp, "gone.jsonl"), 0, strict=True)
    except OSError:
        raised = True
    check("strict=True refuses to call an unreadable file clean", raised)
finally:
    shutil.rmtree(tmp, ignore_errors=True)


# ---- 5. /new never switches onto a session it could not verify -------
print("\n/new refuses to activate an unverified session")

sessions = tempfile.mkdtemp(prefix="bridge-sessions-")
saved_sessions_dir = b.SESSIONS_DIR
saved_state = dict(b.state)
try:
    b.SESSIONS_DIR = sessions
    b.subprocess.run = lambda cmd, **kw: FakeProc()
    b.run_aside = lambda *a, **k: (0, "ok", "")
    b._prepare_new_session = lambda sid: None

    def reset(session_id="previous0000"):
        TEXTS.clear()
        b.state["session_id"] = session_id
        b.state["model"] = "claude-sonnet-5"

    def make_session(sid, body):
        d = os.path.join(sessions, "2026-08-03_" + sid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "messages.jsonl"), "w") as f:
            f.write(body)
        return d

    PERSONA_LINE = json.dumps({
        "role": "user",
        "content": [{"type": "text",
                     "text": "this is your permanent telegram thread"}],
    }) + "\n"

    # (a) a session whose very first turn the provider refused
    reset()
    make_session("refusedaaaa", PERSONA_LINE + json.dumps({
        "role": "assistant", "stopReason": "error",
        "errorMessage": "model not available for this account",
        "content": [],
    }) + "\n")
    b.heavy_new()
    check("a refused first turn is reported, not activated",
          b.state["session_id"] == "previous0000"
          and any("couldn't start" in t for t in TEXTS))
    check("and the hint is a command this install accepts",
          any(b.model_switch_hint() in t for t in TEXTS))

    shutil.rmtree(os.path.join(sessions, "2026-08-03_refusedaaaa"))
    make_session("healthyccc", PERSONA_LINE)

    # (b) THE REGRESSION, both halves of it. The check was
    #
    #     failed = read_error_since(mf, 0) if mf else ""
    #
    # and read_error_since swallows OSError and returns "". So both "the
    # transcript is not there" and "the transcript could not be read"
    # produced the same empty string as "the first turn was fine", and the
    # bridge switched onto a session it had verified nothing about. The
    # session dir can be renamed or the file pulled between the discovery
    # scan and this read, so these are stubbed rather than raced.
    saved_msg_file = b.session_msg_file
    saved_read_error = b.read_error_since
    try:
        reset()
        b.session_msg_file = lambda sid: None
        b.heavy_new()
        check("a session with no transcript is not activated",
              b.state["session_id"] == "previous0000"
              and any("transcript" in t for t in TEXTS))

        reset()
        b.session_msg_file = saved_msg_file

        def boom(mf, offset, strict=False):
            if strict:
                raise OSError(13, "Permission denied")
            return ""

        b.read_error_since = boom
        b.heavy_new()
        check("an unreadable transcript is not treated as clean",
              b.state["session_id"] == "previous0000"
              and any("transcript" in t for t in TEXTS))
    finally:
        b.session_msg_file = saved_msg_file
        b.read_error_since = saved_read_error

    # (c) and the happy path still activates
    reset()
    b.heavy_new()
    check("a clean session is still switched to",
          b.state["session_id"] == "healthyccc"
          and any("fresh session ready" in t for t in TEXTS))
finally:
    b.SESSIONS_DIR = saved_sessions_dir
    b.state.clear()
    b.state.update(saved_state)
    shutil.rmtree(sessions, ignore_errors=True)


# ---- 6. accounts.json can be anything at all -------------------------
print("\nsetup.py account detection")

home = tempfile.mkdtemp(prefix="bridge-home-")
saved_expand = os.path.expanduser
try:
    os.makedirs(os.path.join(home, ".aside"), exist_ok=True)
    accounts = os.path.join(home, ".aside", "accounts.json")

    def fake_expand(p):
        return p.replace("~", home, 1) if p.startswith("~") else p

    setup.os.path.expanduser = fake_expand

    def write(raw):
        with open(accounts, "w") as f:
            f.write(raw)

    write(json.dumps({"currentAccountId": 2}))
    check("reads the current account id",
          setup.detect_aside_account().endswith("/.aside/u/2"))

    # The crash: json.load returns a list, `.get` raises AttributeError,
    # which is not in the handler -- so the wizard died with a traceback
    # at "Checking your machine" over a file it only consults as a hint.
    for raw, why in [("[]", "a list"), ("null", "null"), ('"u/1"', "a string"),
                     ("7", "a number"), ("{", "truncated json")]:
        write(raw)
        try:
            got = setup.detect_aside_account()
            ok = got.endswith("/.aside/u/0")
        except Exception as e:  # noqa: BLE001
            ok = False
            got = "raised %s" % type(e).__name__
        check("%s falls back to u/0 (%s)" % (why, got), ok)

    # isinstance(True, int) is True in Python, and u/True is not a path.
    write(json.dumps({"currentAccountId": True}))
    check("a boolean is not read as account 1",
          setup.detect_aside_account().endswith("/.aside/u/0"))

    write(json.dumps({"currentAccountId": -3}))
    check("a negative id falls back",
          setup.detect_aside_account().endswith("/.aside/u/0"))

    os.unlink(accounts)
    check("a missing file falls back",
          setup.detect_aside_account().endswith("/.aside/u/0"))
finally:
    setup.os.path.expanduser = saved_expand
    shutil.rmtree(home, ignore_errors=True)


# ---- 7. the tunnel-url scrape survives a log with bad bytes ----------
print("\nsetup-miniapp.py tunnel url scrape")

logs = tempfile.mkdtemp(prefix="miniapp-logs-")
try:
    log_path = os.path.join(logs, "miniapp.log")
    with open(log_path, "wb") as f:
        # cloudflared's own output, verbatim, read while it is still being
        # written -- so the tail is a half-written multi-byte character.
        f.write(b"INF public url: https://shiny-otter-pool-vast"
                b".trycloudflare.com\n")
        f.write(b"INF caf\xc3\n")

    check("finds the url past the undecodable line",
          miniapp_setup.find_tunnel_url([log_path], attempts=1)
          == "https://shiny-otter-pool-vast.trycloudflare.com")

    with open(log_path, "wb") as f:
        f.write(b"ERR failed to request quick tunnel from "
                b"https://api.trycloudflare.com\n")
        f.write(b"\xff\xfe not utf-8 at all\n")
    check("still refuses cloudflared's own api host",
          miniapp_setup.find_tunnel_url([log_path], attempts=1) is None)

    check("a missing log is not an error",
          miniapp_setup.find_tunnel_url(
              [os.path.join(logs, "nope.log")], attempts=1) is None)
finally:
    shutil.rmtree(logs, ignore_errors=True)

shutil.rmtree(FIXTURE_ROOT, ignore_errors=True)

print("\n%d failed" % len(fails))
for name in fails:
    print("  - " + name)
sys.exit(1 if fails else 0)
