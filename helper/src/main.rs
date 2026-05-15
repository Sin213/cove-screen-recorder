use clap::Parser;
use std::{process, sync::Arc};
use tracing::info;

use cove_replay_engine::{protocol::version, SetLevelFn};

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
    /// Run in simulation mode (no real capture/encoder/export).
    #[arg(long, alias = "stub-mode")]
    simulate: bool,
    /// Encoder backend name reported by the simulator.
    #[arg(long, default_value = "nvenc")]
    simulate_encoder: String,
    /// Inject a simulated failure: target=reason (repeatable), e.g. "capture.startStream=pipewire-state-error".
    #[arg(long, action = clap::ArgAction::Append)]
    simulate_fail: Vec<String>,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    if args.print_protocol_version {
        println!("{}", version::PROTOCOL_VERSION);
        process::exit(0);
    }

    let Some(ref ipc_socket) = args.ipc_socket else {
        eprintln!(
            "cove-replay-engine is invoked by the Electron main process and should not be run directly."
        );
        process::exit(1);
    };

    let set_level = init_logging(args.log_level.as_str(), args.log_dir.as_deref());

    info!(
        version = version::HELPER_VERSION,
        protocol_version = version::PROTOCOL_VERSION,
        "cove-replay-engine started"
    );

    let run_result = if args.simulate {
        use cove_replay_engine::{
            sim::{parse_fail_specs, SimConfig, SimState},
            transport::server::{run_with_config, RunConfig},
        };
        let fail_specs = match parse_fail_specs(&args.simulate_fail) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("fatal: {e}");
                process::exit(1);
            }
        };
        let config = SimConfig { encoder: args.simulate_encoder, fail_specs: std::sync::Mutex::new(fail_specs) };
        let sim = SimState::new(config);
        run_with_config(ipc_socket, set_level, RunConfig { sim: Some(sim) }).await
    } else {
        cove_replay_engine::transport::server::run(ipc_socket, set_level).await
    };
    if let Err(e) = run_result {
        eprintln!("fatal: {e}");
        process::exit(1);
    }
}

fn init_logging(log_level: &str, log_dir: Option<&str>) -> SetLevelFn {
    use std::fs::OpenOptions;
    use tracing_subscriber::{
        filter::LevelFilter, layer::SubscriberExt, reload, util::SubscriberInitExt,
    };

    let level: LevelFilter = log_level.parse().unwrap_or(LevelFilter::INFO);
    let (filter, handle) = reload::Layer::new(level);

    if let Some(dir) = log_dir {
        let log_path = std::path::Path::new(dir).join("engine.log");
        std::fs::create_dir_all(dir).ok();
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .expect("failed to open engine.log");
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().json().with_writer(
                std::sync::Mutex::new(log_file),
            ))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().json().with_writer(std::io::stderr))
            .init();
    }

    Arc::new(move |new_level: tracing::Level| {
        handle
            .modify(|f| *f = LevelFilter::from(new_level))
            .map_err(|e| anyhow::anyhow!("reload failed: {e}"))
    })
}
