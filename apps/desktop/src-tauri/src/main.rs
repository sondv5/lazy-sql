// Prevents an extra console window on Windows in release builds (debug keeps it for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lazy_sql_lib::run()
}
