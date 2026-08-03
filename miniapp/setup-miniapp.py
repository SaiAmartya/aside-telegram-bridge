#!/usr/bin/env python3
"""Interactive setup wizard for the Aside Telegram Mini App.

Run:  python3 miniapp/setup-miniapp.py

Installs the Mini App server alongside the existing chat bridge. The only
real prerequisite is Node 20+; everything else -- the cloudflared tunnel
binary included -- is fetched by the server itself at runtime.

Idempotent: safe to re-run any time to reconfigure. This never touches
setup.py, install.sh, or the running bridge.
"""
import json
import os
import re
import plistlib
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

MINIAPP_DIR = os.path.dirname(os.path.realpath(__file__))
BRIDGE_DIR = os.path.dirname(MINIAPP_DIR)
# setup.py writes config.json into the checkout; the ~/.aside path is the
# older documented home. Search both so running this wizard standalone
# finds the config a wizard install actually produced.
CONFIG_CANDIDATES = (
    os.path.join(BRIDGE_DIR, "config.json"),
    os.path.expanduser("~/.aside/u/0/telegram-bridge/config.json"),
)
LABEL = "com.aside.miniapp"
PLIST_PATH = os.path.expanduser("~/Library/LaunchAgents/%s.plist" % LABEL)

MIN_NODE_MAJOR = 20
DEFAULT_PORT = 8790

BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"


def say(msg=""):
    print(msg)


def ok(msg):
    print("%s  ✓ %s%s" % (GREEN, msg, RESET))


def warn(msg):
    print("%s  ! %s%s" % (YELLOW, msg, RESET))


def fail(msg):
    print("%s  ✗ %s%s" % (RED, msg, RESET))


def step(n, total, msg):
    print("\n%s[%d/%d] %s%s" % (BOLD, n, total, msg, RESET))


def ask(prompt, default=None):
    suffix = " [%s]" % default if default else ""
    try:
        v = input("%s%s%s%s: " % (BOLD, prompt, suffix, RESET)).strip()
    except (EOFError, KeyboardInterrupt):
        say("\nsetup cancelled.")
        sys.exit(1)
    return v or (default or "")


def ask_yes_no(prompt, default=False):
    hint = "Y/n" if default else "y/N"
    answer = ask("%s (%s)" % (prompt, hint), "")
    if not answer:
        return default
    return answer.strip().lower().startswith("y")


# --- step 1: Node --------------------------------------------------------


def check_node():
    """Node 20+ is the one thing we cannot install for the user."""
    node = shutil.which("node")
    if not node:
        fail("Node.js is not installed.")
        say()
        say("  Install it, then re-run this script:")
        say("    %s- Homebrew:  brew install node%s" % (DIM, RESET))
        say("    %s- Installer: https://nodejs.org/ (LTS)%s" % (DIM, RESET))
        sys.exit(1)

    try:
        raw = subprocess.check_output([node, "--version"], text=True).strip()
        major = int(raw.lstrip("v").split(".")[0])
    except Exception:
        warn("could not read the Node version; continuing anyway")
        return node

    if major < MIN_NODE_MAJOR:
        fail("Node %s is too old -- the server needs %d or newer."
             % (raw, MIN_NODE_MAJOR))
        say("    %sbrew upgrade node%s   (or reinstall from nodejs.org)"
            % (DIM, RESET))
        sys.exit(1)

    ok("Node %s" % raw)
    return node


# --- step 2: build -------------------------------------------------------


def build():
    npm = shutil.which("npm")
    if not npm:
        fail("npm not found even though Node is installed.")
        sys.exit(1)

    for args, label in (
        (["install"], "installing dependencies"),
        (["run", "build"], "building the server and web app"),
    ):
        say("  %s%s...%s" % (DIM, label, RESET))
        proc = subprocess.run([npm] + args, cwd=MINIAPP_DIR)
        if proc.returncode != 0:
            fail("`npm %s` failed" % " ".join(args))
            sys.exit(1)
    ok("built")


# --- step 3: config ------------------------------------------------------


def discover_config():
    """The bridge config this machine actually has, or None."""
    env = os.environ.get("MINIAPP_CONFIG")
    if env:
        return os.path.expanduser(env)
    for candidate in CONFIG_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


def load_config(path):
    if not os.path.exists(path):
        fail("bridge config not found at %s" % path)
        say("  The Mini App reuses the chat bridge's bot token and chat id,")
        say("  so the bridge has to be set up first:")
        say("    %spython3 %s%s"
            % (DIM, os.path.join(BRIDGE_DIR, "setup.py"), RESET))
        say("  Looked in:")
        for candidate in CONFIG_CANDIDATES:
            say("    %s%s%s" % (DIM, candidate, RESET))
        sys.exit(1)
    with open(path) as fh:
        return json.load(fh)


def write_config(path, config):
    """Rewrite the config in place, preserving permissions."""
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(config, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def configure(config_path):
    config = load_config(config_path)
    section = config.get("miniapp") or {}

    port = ask("Port for the Mini App server",
               str(section.get("port", DEFAULT_PORT)))
    try:
        port = int(port)
    except ValueError:
        port = DEFAULT_PORT

    say()
    say("  %sA Telegram Mini App must be reachable over public HTTPS."
        % DIM)
    say("  cloudflared gives you that with no account and no extra")
    say("  install -- the server downloads it on first run.%s" % RESET)
    use_tunnel = ask_yes_no("  Manage a cloudflared tunnel automatically?",
                            default=True)

    cloudflared_path = ""
    if use_tunnel:
        existing = shutil.which("cloudflared")
        say()
        say("  %sThe server downloads a pinned cloudflared release and"
            % DIM)
        say("  verifies its SHA-256 against a checksum vendored in this")
        say("  repo before running it. If you would rather run a copy you")
        say("  installed and trust yourself, point it at one.%s" % RESET)
        if existing:
            if ask_yes_no("  Use the cloudflared already at %s?" % existing,
                          default=True):
                cloudflared_path = existing
        else:
            answer = ask("  Path to your own cloudflared (blank to let the"
                         " server fetch one)", "")
            if answer:
                cloudflared_path = os.path.expanduser(answer)
                if not os.path.exists(cloudflared_path):
                    warn("  %s does not exist -- the server will fetch its"
                         " own instead" % cloudflared_path)
                    cloudflared_path = ""

    say()
    say("  %sThe menu button is the 'Aside' entry next to the message box"
        % DIM)
    say("  in your chat with the bot. Turning this on re-points it at the")
    say("  tunnel URL each time that URL changes.%s" % RESET)
    warn("  Your bot is live. This rewrites its menu button.")
    say("  %sThe menu button is bot-wide, so ONE bot can point at ONE Mini"
        % DIM)
    say("  App at a time: turning this on here takes the button away from")
    say("  any other machine or dev instance using the same bot token. If")
    say("  you want two, make a second bot with @BotFather.%s" % RESET)
    say("  %sSay no only if this bot's button is already pointed somewhere"
        % DIM)
    say("  you want to keep -- a quick tunnel's URL changes on every")
    say("  restart, and only this setting re-points the button when it"
        " does.%s" % RESET)
    auto_menu = ask_yes_no("  Register the menu button automatically?",
                           default=True)

    section.update({
        "port": port,
        "tunnel": "cloudflared" if use_tunnel else "none",
        "auto_register_menu": bool(auto_menu),
    })
    if cloudflared_path:
        section["cloudflared_path"] = cloudflared_path
    else:
        section.pop("cloudflared_path", None)
    section.setdefault("state_dir", os.path.dirname(config_path))
    config["miniapp"] = section
    write_config(config_path, config)

    ok("config written to %s" % config_path)
    if not auto_menu:
        say("    %smenu registration stays off; flip"
            " miniapp.auto_register_menu to true when you want it%s"
            % (DIM, RESET))
    return section


# --- step 4: launchd -----------------------------------------------------


def install_service(config_path, section):
    node = shutil.which("node")
    entry = os.path.join(MINIAPP_DIR, "server", "dist", "index.js")
    if not os.path.exists(entry):
        fail("build output missing at %s" % entry)
        sys.exit(1)

    state_dir = section.get("state_dir") or os.path.dirname(config_path)
    out_log = os.path.join(state_dir, "miniapp.out.log")
    err_log = os.path.join(state_dir, "miniapp.err.log")

    plist = {
        "Label": LABEL,
        "ProgramArguments": [node, entry],
        "EnvironmentVariables": {
            "MINIAPP_CONFIG": config_path,
            "MINIAPP_PORT": str(section.get("port", DEFAULT_PORT)),
            # launchd starts with a minimal PATH; the server shells out to
            # the aside CLI and to tar for the cloudflared tarball.
            "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": out_log,
        "StandardErrorPath": err_log,
        "WorkingDirectory": MINIAPP_DIR,
    }

    os.makedirs(os.path.dirname(PLIST_PATH), exist_ok=True)
    with open(PLIST_PATH, "wb") as fh:
        plistlib.dump(plist, fh)
    ok("wrote %s" % PLIST_PATH)

    uid = os.getuid()
    # bootout first so a re-run reloads rather than colliding with itself.
    subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (uid, LABEL)],
                   capture_output=True)
    proc = subprocess.run(
        ["launchctl", "bootstrap", "gui/%d" % uid, PLIST_PATH],
        capture_output=True, text=True)
    if proc.returncode != 0:
        # Older macOS wants load -w.
        proc = subprocess.run(["launchctl", "load", "-w", PLIST_PATH],
                              capture_output=True, text=True)
    if proc.returncode != 0:
        fail("launchctl could not start the service")
        say((proc.stderr or "").strip())
        sys.exit(1)
    ok("service loaded (%s)" % LABEL)
    return out_log, err_log


# --- step 5: health ------------------------------------------------------


def health_check(port, attempts=20):
    url = "http://127.0.0.1:%d/api/health" % port
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=2) as res:
                if json.load(res).get("ok"):
                    ok("server healthy on port %d" % port)
                    return True
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(1)
    fail("server did not answer %s" % url)
    return False


# Hosts under trycloudflare.com that are NOT this machine's tunnel.
# cloudflared talks to api.trycloudflare.com to register a quick tunnel and
# names it in its own error text, so a naive "first https:// on a line
# mentioning trycloudflare" search can report the API endpoint as the public
# URL. A real quick-tunnel hostname is a multi-word hyphenated slug.
_TUNNEL_RESERVED = {"api", "www", "dash", "developers", "update",
                    "protocol-v2", "region1", "region2"}
_TUNNEL_RE = re.compile(r"https://([a-z0-9-]+)\.trycloudflare\.com")


def is_quick_tunnel_url(url):
    m = _TUNNEL_RE.match(url or "")
    if not m:
        return False
    label = m.group(1)
    return label not in _TUNNEL_RESERVED and "-" in label


def find_tunnel_url(log_paths, attempts=30):
    """The server logs the tunnel hostname once cloudflared reports it."""
    for _ in range(attempts):
        for path in log_paths:
            try:
                # The server log carries cloudflared's own stdout/stderr
                # verbatim, and this reads it while both are still being
                # written -- so a read routinely lands mid-character, and
                # strict decoding raises UnicodeDecodeError. That is a
                # ValueError, not an OSError, so it escaped the handler
                # below and ended the setup wizard with a traceback at the
                # very last step, after the multi-minute build. Replacing
                # the bad bytes costs nothing: the hostname this is
                # looking for is ASCII.
                with open(path, encoding="utf-8", errors="replace") as fh:
                    for line in reversed(fh.read().splitlines()):
                        for m in _TUNNEL_RE.finditer(line):
                            url = m.group(0)
                            if is_quick_tunnel_url(url):
                                return url
            except OSError:
                pass
        time.sleep(2)
    return None


# --- main ----------------------------------------------------------------


def main():
    say("%s\n  Aside Telegram Mini App -- setup\n%s" % (BOLD, RESET))
    total = 5

    step(1, total, "Checking prerequisites")
    check_node()
    # Resolved before the build, not after: `npm install && npm run build`
    # takes minutes, and finding out afterwards that there is no bridge
    # config to read wastes all of it.
    config_path = discover_config()
    if config_path and os.path.exists(config_path):
        ok("bridge config at %s" % config_path)
    else:
        config_path = ask("  Bridge config path", CONFIG_CANDIDATES[0])
        config_path = os.path.expanduser(config_path)
        load_config(config_path)  # exits with guidance if it is not there

    step(2, total, "Building")
    build()

    step(3, total, "Configuring")
    section = configure(config_path)

    step(4, total, "Installing the background service")
    out_log, err_log = install_service(config_path, section)

    step(5, total, "Verifying")
    port = section.get("port", DEFAULT_PORT)
    if not health_check(port):
        say("  logs: %s" % err_log)
        sys.exit(1)

    url = None
    if section.get("tunnel") == "cloudflared":
        say("  %swaiting for the tunnel (first run downloads cloudflared)"
            "...%s" % (DIM, RESET))
        url = find_tunnel_url([out_log, err_log])
        if url:
            ok("public URL: %s" % url)
        else:
            warn("no tunnel URL yet -- check %s in a moment" % err_log)

    say()
    say("%s  Done.%s" % (GREEN + BOLD, RESET))
    say()
    if section.get("tunnel") != "cloudflared":
        say("  The tunnel is off, so there is no public HTTPS URL and")
        say("  Telegram cannot reach this server yet. The Mini App needs")
        say("  one: re-run this wizard and say yes to the tunnel, or point")
        say("  miniapp.tunnel at your own.")
    elif section.get("auto_register_menu"):
        if url:
            say("  Open Telegram and tap the %sAside%s button next to the"
                % (BOLD, RESET))
            say("  message box in your chat with the bot.")
            say("  %sIf it is not there yet, give it a few seconds and"
                % DIM)
            say("  reopen the chat -- Telegram caches the button.%s" % RESET)
        else:
            say("  The tunnel had not come up yet, so the menu button is")
            say("  not registered. The server does it by itself as soon as")
            say("  the URL appears -- watch for it with:")
            say("    %sbridgemon miniapp logs%s" % (DIM, RESET))
    else:
        say("  Menu registration is off, so there is no %sAside%s button"
            % (BOLD, RESET))
        say("  in Telegram yet. To get one, either:")
        say("    - set %sminiapp.auto_register_menu%s to true in %s,"
            % (BOLD, RESET, config_path))
        say("      then %sbridgemon miniapp restart%s  (recommended --"
            % (BOLD, RESET))
        say("      it re-points the button when the URL rotates)")
        say("    - or set it by hand in @BotFather → Bot Settings →")
        say("      Menu Button%s" % (":" if url else ""))
        if url:
            say("        %s%s%s" % (BOLD, url, RESET))
            say("      %s(this URL dies on the next restart)%s"
                % (DIM, RESET))
    say()
    say("  %sNote: a quick tunnel's URL changes on every restart. The"
        % DIM)
    say("  server re-registers the menu button when it does (if that is")
    say("  enabled). For a URL that never moves, set up a named tunnel")
    say("  with your own domain and point miniapp at it instead.%s" % RESET)
    say()
    say("  Manage it from the same place as the bridge:")
    say("    %sbridgemon status            both services at a glance%s"
        % (DIM, RESET))
    say("    %sbridgemon miniapp logs      what the server is saying%s"
        % (DIM, RESET))
    say("    %sbridgemon miniapp restart   after a config change%s"
        % (DIM, RESET))
    say("    %sbridgemon update            pull, rebuild, restart both%s"
        % (DIM, RESET))
    say()
    say("  %slogs:    %s%s" % (DIM, err_log, RESET))
    say("  %srestart: launchctl kickstart -k gui/%d/%s%s"
        % (DIM, os.getuid(), LABEL, RESET))
    say()


if __name__ == "__main__":
    main()
