use std::{env, thread, time::{Duration, Instant}};
#[link(name = "user32")]
extern "system" { fn GetAsyncKeyState(key: i32) -> i16; }
fn main() {
    let keys: Vec<i32> = env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
    if keys.is_empty() || keys.iter().any(|k| *k < 1 || *k > 254) { std::process::exit(2); }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(600) {
        if keys.iter().any(|k| unsafe { GetAsyncKeyState(*k) } >= 0) { return; }
        thread::sleep(Duration::from_millis(15));
    }
}
