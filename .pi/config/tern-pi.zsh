# Interactive bash/zsh dispatch for dogfooding Pi's Tern Surface Protocol UI.
# Source through the optional Trebol setup wizard. `pi -nt` uses native Pi.
# Only a bare `pi` in a Tern-owned interactive TTY is intercepted: every
# argument-bearing, piped, remote/non-Tern invocation retains native Pi.
pi() {
  local runner=${TREBOL_TERN_RUNNER:-'/Users/swarm/Work/Clover/trebol/.pi/lib/tern/run.ts'}
  # Shell-only no-Tern bypass. Recognize exactly one leading token; Pi's
  # executable does not know -nt. Leave all remaining argv boundaries intact.
  if [[ ${1:-} == -nt ]]; then
    shift
    command pi "$@"
    return $?
  fi
  if [[ $# -eq 0 && -t 0 && -t 1 &&
        ${TERM_PROGRAM:-} == tern && -n ${TERN_PANE:-} &&
        ${PI_TERN_UI:-1} != 0 && -r $runner ]] && command -v node >/dev/null 2>&1; then
    command node --experimental-strip-types "$runner"
  else
    command pi "$@"
  fi
}
