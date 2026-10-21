// Trebol differential harness (artifact-only; not part of upstream).
// Usage: trebol_oracle <cwd> <patch-file>
// Runs the agent path: verify (maybe_parse_apply_patch_verified) with NO writes,
// then execute (apply_patch_with_options) only when verification succeeded.
// Exit: 0 applied, 3 verification rejected (no writes), 1 execution failure.
use codex_apply_patch::{
    ApplyPatchOptions, MaybeApplyPatchVerified, apply_patch_with_options,
    maybe_parse_apply_patch_verified,
};
use codex_utils_path_uri::PathUri;

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    let cwd_arg = args.next().expect("usage: trebol_oracle <cwd> <patch-file>");
    let patch_file = args.next().expect("usage: trebol_oracle <cwd> <patch-file>");
    let patch = std::fs::read_to_string(&patch_file).expect("read patch file");
    let cwd = PathUri::from_host_native_path(&cwd_arg).expect("absolute cwd");
    let fs = codex_exec_server::LOCAL_FS.as_ref();

    let argv = vec!["apply_patch".to_string(), patch.clone()];
    match maybe_parse_apply_patch_verified(&argv, &cwd, fs, None).await {
        MaybeApplyPatchVerified::Body(_) => {}
        MaybeApplyPatchVerified::CorrectnessError(e) => {
            eprintln!("VERIFY_REJECT: {e:?}");
            return std::process::ExitCode::from(3);
        }
        _ => {
            eprintln!("VERIFY_OTHER");
            return std::process::ExitCode::from(3);
        }
    }

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    match apply_patch_with_options(
        &patch,
        ApplyPatchOptions {
        follow_symlinks: std::env::var_os("TREBOL_ORACLE_NO_FOLLOW").is_none(),
    },
        &cwd,
        &mut stdout,
        &mut stderr,
        fs,
        None,
    )
    .await
    {
        Ok(_) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("EXEC_FAILURE: {}", String::from_utf8_lossy(&stderr).trim());
            std::process::ExitCode::from(1)
        }
    }
}
