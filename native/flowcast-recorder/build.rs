// Embeds flowcast.manifest into the executable so Windows treats us as
// per-monitor DPI aware. See the manifest itself for why that matters.
//
// Done with a linker flag rather than the `embed-manifest` crate to keep the
// dependency list as small as possible — this binary reads the user's screen,
// so every crate in it is a crate someone may one day audit.

fn main() {
    println!("cargo:rerun-if-changed=flowcast.manifest");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("flowcast.manifest");
        println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
