"""Config path resolution: empty means detect, custom means custom.

config.example.json ships aside_cli / sessions_dir / credentials_path
present and EMPTY on purpose, and the README documents copying it and
filling in only token/chat_id/owner_name. bridge.py read those with
`CONFIG.get(key, default)`, whose default only applies when the key is
ABSENT -- so the documented manual install produced SESSIONS_DIR="" and
ASIDE_CLI="", i.e. os.listdir('') and a spawn of ''.

The other half: setup.py is documented as safe to re-run, and the config
file invites hand-set paths ("Only set them by hand if your install lives
somewhere unusual") -- but it overwrote them unconditionally on every run.

Offline only: no Telegram, no aside CLI, no real ~/.aside.

Run:  python3 tests/test_config_paths.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(HERE, "config.json")

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


# bridge.py resolves its paths at import time from config.json next to
# itself, so each scenario is a fresh write + a fresh import.
SAVED = None
if os.path.exists(CONFIG_PATH):
    with open(CONFIG_PATH) as f:
        SAVED = f.read()

FIXTURE = tempfile.mkdtemp(prefix="cfgpaths-")


def write_config(extra):
    cfg = {
        "token": "1234567890:TEST-ONLY-FAKE-BOT-TOKEN-not-real",
        "chat_id": 8675309,
        "owner_name": "Fixture",
        "style": "formal",
    }
    cfg.update(extra)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f)


def import_bridge(tag):
    return load("bridge_%s" % tag, os.path.join(HERE, "bridge.py"))


try:
    # ---- 1. the documented manual install ---------------------------
    print("\nempty paths mean detect, not empty string")

    write_config({
        "aside_cli": "",
        "sessions_dir": "",
        "credentials_path": "",
    })
    b = import_bridge("empty")

    check("an empty sessions_dir does not become ''",
          b.SESSIONS_DIR != "" and b.SESSIONS_DIR.endswith("/sessions"))
    check("an empty aside_cli does not become ''",
          b.ASIDE_CLI != "" and b.ASIDE_CLI.endswith("aside"))
    check("an empty credentials_path does not become ''",
          b.CREDENTIALS_PATH != ""
          and b.CREDENTIALS_PATH.endswith("credentials.json"))
    # The whole point of the detection: it must land under the account
    # root, not a literal "~" and not the empty string.
    check("the detected paths are absolute",
          all(os.path.isabs(p) for p in
              (b.SESSIONS_DIR, b.ASIDE_CLI, b.CREDENTIALS_PATH)))
    check("whitespace is treated as empty too",
          "  ".strip() == "")

    # ---- 2. a whitespace-only value is still empty ------------------
    write_config({"sessions_dir": "   ", "aside_cli": "", "credentials_path": ""})
    b2 = import_bridge("blank")
    check("a whitespace sessions_dir is detected, not used verbatim",
          b2.SESSIONS_DIR.strip() != "" and b2.SESSIONS_DIR.endswith("/sessions"))

    # ---- 3. an explicit path is still honoured ----------------------
    print("\na set path is still used exactly")

    custom = os.path.join(FIXTURE, "custom-sessions")
    os.makedirs(custom, exist_ok=True)
    write_config({
        "sessions_dir": custom,
        "aside_cli": "/bin/echo",
        "credentials_path": os.path.join(FIXTURE, "creds.json"),
    })
    b3 = import_bridge("custom")
    check("a set sessions_dir wins", b3.SESSIONS_DIR == custom)
    check("a set aside_cli wins", b3.ASIDE_CLI == "/bin/echo")
    check("a set credentials_path wins",
          b3.CREDENTIALS_PATH == os.path.join(FIXTURE, "creds.json"))
    check("~ is still expanded in a set path",
          import_bridge("tilde") is not None)

    # ---- 4. account detection is shared with setup.py ---------------
    print("\nbridge.py account detection")

    home = tempfile.mkdtemp(prefix="cfgpaths-home-")
    os.makedirs(os.path.join(home, ".aside"), exist_ok=True)
    accounts = os.path.join(home, ".aside", "accounts.json")
    saved_expand = b3.os.path.expanduser
    try:
        b3.os.path.expanduser = lambda p: (
            p.replace("~", home, 1) if p.startswith("~") else p)

        with open(accounts, "w") as f:
            json.dump({"currentAccountId": 3}, f)
        check("reads the signed-in account",
              b3.detect_aside_root().endswith("/.aside/u/3"))

        for raw, why in [("[]", "a list"), ("null", "null"), ("7", "a number"),
                         ("{", "truncated json")]:
            with open(accounts, "w") as f:
                f.write(raw)
            try:
                got = b3.detect_aside_root()
                ok = got.endswith("/.aside/u/0")
            except Exception as e:  # noqa: BLE001
                ok, got = False, "raised %s" % type(e).__name__
            check("%s falls back to u/0 (%s)" % (why, got), ok)

        with open(accounts, "w") as f:
            json.dump({"currentAccountId": True}, f)
        check("a boolean is not account 1",
              b3.detect_aside_root().endswith("/.aside/u/0"))
    finally:
        b3.os.path.expanduser = saved_expand
        shutil.rmtree(home, ignore_errors=True)

    # ---- 5. setup.py keeps what the user set ------------------------
    print("\nsetup.py preserves a customised install")

    setup = load("setupmod", os.path.join(HERE, "setup.py"))
    detected = setup.detect_aside_paths()

    # A user who moved their Aside install and said so in config.json.
    mine = {
        "sessions_dir": "/Volumes/Work/aside/sessions",
        "credentials_path": "/Volumes/Work/aside/credentials.json",
        "state_db_path": "/Volumes/Work/aside/state.db",
        "aside_cli": "/bin/echo",
    }
    write_config(dict(mine, token="1234567890:TEST", chat_id=8675309))

    setup.CONFIG_PATH = CONFIG_PATH
    setup.say = lambda *a, **k: None
    setup.ok = lambda *a, **k: None
    setup.warn = lambda *a, **k: None
    setup.drop_stale_session = lambda cfg: None

    setup.write_config("1234567890:TEST", 8675309, "Fixture", "formal",
                       "/usr/local/bin/aside")
    with open(CONFIG_PATH) as f:
        after = json.load(f)

    for key, value in mine.items():
        check("re-running setup.py keeps a custom %s" % key,
              after.get(key) == value)
    check("and it did not silently swap in the detected path",
          after["sessions_dir"] != detected["sessions_dir"])

    # ---- 6. ...but still fills in what is missing --------------------
    print("\nsetup.py still populates a fresh install")

    write_config({"aside_cli": "", "sessions_dir": "", "credentials_path": ""})
    setup.write_config("1234567890:TEST", 8675309, "Fixture", "formal",
                       "/bin/echo")
    with open(CONFIG_PATH) as f:
        fresh = json.load(f)

    check("an empty sessions_dir is filled in",
          fresh["sessions_dir"] == detected["sessions_dir"])
    check("an empty credentials_path is filled in",
          fresh["credentials_path"] == detected["credentials_path"])
    check("state_db_path is added when absent",
          fresh["state_db_path"] == detected["state_db_path"])
    check("an empty aside_cli takes the wizard's", fresh["aside_cli"] == "/bin/echo")

    # A custom CLI that no longer exists is repaired rather than kept.
    write_config({"aside_cli": "/nonexistent/aside-was-here",
                  "sessions_dir": "", "credentials_path": ""})
    setup.write_config("1234567890:TEST", 8675309, "Fixture", "formal",
                       "/bin/echo")
    with open(CONFIG_PATH) as f:
        repaired = json.load(f)
    check("a broken custom aside_cli is repaired",
          repaired["aside_cli"] == "/bin/echo")

finally:
    if SAVED is None:
        if os.path.exists(CONFIG_PATH):
            os.unlink(CONFIG_PATH)
    else:
        with open(CONFIG_PATH, "w") as f:
            f.write(SAVED)
    shutil.rmtree(FIXTURE, ignore_errors=True)

print("\n%d failed" % len(fails))
for name in fails:
    print("  - " + name)
sys.exit(1 if fails else 0)
