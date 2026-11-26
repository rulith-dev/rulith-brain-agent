// Rulith Brain Agent: no console window in a release build
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rulith_brain_agent_lib::run()
}
