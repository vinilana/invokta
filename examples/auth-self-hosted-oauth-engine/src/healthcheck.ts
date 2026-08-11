import { connect } from "node:net";

const port = Number(process.env.INVOKTA_HTTP_PORT ?? "3000");
const socket = connect({ host: "127.0.0.1", port });
const timeout = setTimeout(() => {
  socket.destroy();
  process.exit(1);
}, 2_000);

socket.once("connect", () => {
  clearTimeout(timeout);
  socket.end();
  process.exit(0);
});
socket.once("error", () => {
  clearTimeout(timeout);
  process.exit(1);
});
