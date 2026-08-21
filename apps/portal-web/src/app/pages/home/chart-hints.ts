export const CHART_HINTS = {
  cpu: 'Cada color es un estado de CPU. user es trabajo de aplicaciones, system es el kernel, iowait es espera de disco. Si iowait sube, el host espera I/O. Si user y system se acercan al 100%, la CPU esta saturada.',
  load: '1m, 5m y 15m son la cola de procesos en esos intervalos. Compare con el numero de cores: por encima de ese valor el host no da abasto.',
  memory: 'used es RAM de procesos. cached y buffered son cache recuperable. free esta libre. Si used crece y cached baja, hay presion de memoria.',
  processes: 'CPU se muestra como % de un nucleo, como en top. Las barras comparan con el proceso mas alto. RSS es memoria residente. I/O es lectura y escritura a disco.',
  diskIo: 'read o receive es lectura; write o transmit es escritura, en bytes por segundo. Un pico sostenido indica carga de disco.',
  diskOps: 'Operaciones de disco por segundo. Muchas ops pequenas saturan el disco aunque el throughput sea bajo.',
  network: 'RX es trafico que entra y TX el que sale, en bytes por segundo. Sirve para ver si el host consume o sirve datos.',
  packets: 'Paquetes por segundo en cada direccion. Si suben y el throughput no, hay muchos paquetes pequenos.',
  netFault: 'errores son fallos de la NIC. descartes son paquetes tirados por cola llena o CPU ocupada. Un valor sostenido merece atencion.',
  tcpConn: 'Estados TCP. established es trafico activo y listen son puertos a la espera. time_wait o syn altos pueden indicar saturacion, fugas o escaneo.',
  otherConn: 'Sockets UDP y el resto de protocolos. UDP no tiene handshake; un salto brusco suele ser un servicio nuevo o un flood.',
  volume: 'Cada punto es un intervalo con logs de la tabla. Pulse uno para filtrarlos. No hay puntos vacios.',
};
