#[tokio::main(flavor = "current_thread")]
async fn main() {
    agent_host::mock::run().await;
}
