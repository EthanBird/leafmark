use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-changed=windows/app.manifest");
    println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let crate_dir = env::var_os("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR");
    let crate_dir = Path::new(&crate_dir);
    let icon = crate_dir.join("../src-tauri/icons/icon.ico");
    let manifest = crate_dir.join("windows/app.manifest");
    assert!(
        icon.is_file(),
        "missing Windows application icon: {}",
        icon.display()
    );
    assert!(
        manifest.is_file(),
        "missing Windows application manifest: {}",
        manifest.display()
    );
    let output_dir = env::var_os("OUT_DIR").expect("missing OUT_DIR");
    let resource = Path::new(&output_dir).join("leafmark-native-compat.rc");
    let resource_text = format!(
        "#define RT_MANIFEST 24\n#define IDI_LEAFMARK 101\nIDI_LEAFMARK ICON \"{}\"\n1 RT_MANIFEST \"{}\"\n",
        rc_path(&icon),
        rc_path(&manifest),
    );
    fs::write(&resource, resource_text).expect("failed to generate Windows resource file");
    embed_resource::compile(&resource, embed_resource::NONE)
        .manifest_required()
        .expect("failed to compile native compatibility resources");
}

fn rc_path(path: &Path) -> String {
    // rc.exe accepts forward slashes in absolute paths. Normalizing here avoids
    // interpreting Windows backslashes as resource-script escape sequences.
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('"', "\"\"")
}
