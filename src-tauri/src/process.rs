//! Child processes (ping, arp, traceroute, ...) started without a console.

use tokio::process::Command;

/// A command for `program` that opens no console window on Windows.
///
/// The release build is a GUI program (`windows_subsystem = "windows"`), so
/// Windows gives each console program it starts a new console window, which
/// flashes on screen for every ping. `CREATE_NO_WINDOW` prevents that.
pub fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
