mod assets;
mod health;
mod journal;
mod resume;
mod server;
mod simulator;
mod startup;
mod system_metrics;
mod web;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    startup::run()
}
