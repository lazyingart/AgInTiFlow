import net from "node:net";

export async function allocateLoopbackTestPort() {
  const reservation = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  const port = typeof address === "object" && address ? Number(address.port) : 0;
  await new Promise((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  if (!port) throw new Error("kernel did not allocate a loopback test port");
  return port;
}
