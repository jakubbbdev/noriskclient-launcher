use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const AFTER: Duration = Duration::from_secs(10);

pub fn due(what: &str, since: Instant) -> bool {
    static PLANNED: OnceLock<Option<String>> = OnceLock::new();
    static FIRED: AtomicBool = AtomicBool::new(false);

    let planned = PLANNED.get_or_init(|| {
        std::env::var("NRC_FAULT")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
    });

    if planned.as_deref() != Some(what) || since.elapsed() < AFTER {
        return false;
    }
    if FIRED.swap(true, Ordering::Relaxed) {
        return false;
    }
    log::warn!("Simulating a {what} failure because NRC_FAULT={what} is set");
    true
}
