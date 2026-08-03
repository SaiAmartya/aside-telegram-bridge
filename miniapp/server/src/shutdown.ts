/**
 * Process-level exit handling.
 *
 * Lives in its own module so it can be tested: `index.ts` runs `main()` on
 * import, so anything defined inline there can only be exercised by
 * starting a real server and crashing it.
 *
 * The rule this file exists to enforce: an exception that escaped every
 * frame ends the process. Node terminates on `uncaughtException` by
 * default, and installing a listener SUPPRESSES that -- so a handler that
 * only logs converts a crash into a wedge. The server then sits there with
 * half-torn state, answering nothing, while launchd's KeepAlive (which
 * only replaces a process that has actually exited) sees a healthy service
 * and does nothing about it. A restarted server is recoverable; a live one
 * that cannot work is not.
 */

export interface CrashHandlerOptions {
  /** Structured log for the crash itself. Must never throw the process down. */
  logFatal: (err: unknown) => void;
  /** Best-effort teardown of side-effecting supervisors (tunnel, menu). */
  stopSupervisors: () => void;
  /** Close the HTTP server. Rejection is fine; the exit does not depend on it. */
  close: () => Promise<unknown>;
  exit: (code: number) => void;
  /** How long `close` gets before the exit happens anyway. */
  graceMs?: number;
  /** Injected in tests. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

export interface SignalHandlerOptions
  extends Omit<CrashHandlerOptions, 'logFatal'> {
  /** Clean shutdown exits 0; only a failed close is a failure. */
  okCode?: number;
}

/**
 * Log, tear down what we can, and exit non-zero — always.
 *
 * Returns the handler rather than registering it, so a test can call it
 * directly and so the caller decides which signal it belongs to.
 */
export function makeCrashHandler(opts: CrashHandlerOptions): (err: unknown) => void {
  const grace = opts.graceMs ?? 3_000;
  const timer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let crashing = false;

  return (err: unknown) => {
    // A throw from inside this handler (a broken logger, a close() that
    // explodes) must not start a second shutdown on top of the first.
    if (crashing) return;
    crashing = true;

    try {
      opts.logFatal(err);
    } catch {
      // Logging is the least important thing happening right now.
    }
    // The backstop: a close() that hangs on the very state that just broke
    // must not keep a dead process alive.
    timer(() => opts.exit(1), grace).unref?.();
    try {
      opts.stopSupervisors();
    } catch {
      // cleanup is best-effort; the exit is not
    }
    opts.close().then(
      () => opts.exit(1),
      () => opts.exit(1),
    );
  };
}

/**
 * SIGINT/SIGTERM: the same shape, but a clean close is a clean exit.
 *
 * Also once-only. A second Ctrl-C used to start a second `app.close()` on
 * an already half-closed server.
 */
export function makeSignalHandler(opts: SignalHandlerOptions): () => void {
  const grace = opts.graceMs ?? 5_000;
  const timer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const ok = opts.okCode ?? 0;
  let stopping = false;

  return () => {
    if (stopping) return;
    stopping = true;
    try {
      opts.stopSupervisors();
    } catch {
      // best effort
    }
    timer(() => opts.exit(1), grace).unref?.();
    opts.close().then(
      () => opts.exit(ok),
      () => opts.exit(1),
    );
  };
}
