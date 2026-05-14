use clap::Parser;
use std::process;
use tracing::info;

#[derive(Parser)]
#[command(name = "cove-replay-engine")]
struct Args {
    #[arg(long)]
    ipc_socket: Option<String>,
    #[arg(long)]
    log_dir: Option<String>,
    #[arg(long, default_value = "info")]
    log_level: String,
    #[arg(long)]
    print_protocol_version: bool,
}

fn main() {
    let args = Args::parse();

    if args.print_protocol_version {
        println!("{}", cove_replay_engine::protocol::version::PROTOCOL_VERSION);
        process::exit(0);
    }

    let Some(ref _ipc_socket) = args.ipc_socket else {
        eprintln!(
            "cove-replay-engine is invoked by the Electron main process and should not be run directly."
        );
        process::exit(1);
    };

    init_logging(args.log_level.as_str(), args.log_dir.as_deref());

    info!(
        version = cove_replay_engine::protocol::version::HELPER_VERSION,
        protocol_version = cove_replay_engine::protocol::version::PROTOCOL_VERSION,
        "cove-replay-engine started"
    );
}

fn init_logging(log_level: &str, log_dir: Option<&str>) {
    use std::fs::OpenOptions;
    use std::sync::Mutex;

    let level: tracing::Level = log_level.parse().unwrap_or(tracing::Level::INFO);

    if let Some(dir) = log_dir {
        let log_path = std::path::Path::new(dir).join("engine.log");
        std::fs::create_dir_all(dir).ok();
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .expect("failed to open engine.log");
        tracing_subscriber::fmt()
            .json()
            .with_max_level(level)
            .with_writer(Mutex::new(log_file))
            .init();
    } else {
        tracing_subscriber::fmt()
            .json()
            .with_max_level(level)
            .with_writer(std::io::stderr)
            .init();
    }
}
