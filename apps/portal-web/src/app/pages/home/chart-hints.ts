export const CHART_HINTS = {
  cpu: 'Cada color es un estado de CPU. user es trabajo de aplicaciones, system es el kernel, iowait es espera de disco. Si iowait sube, el host espera I/O. Si user y system se acercan al 100%, la CPU esta saturada.',
  load: '1m, 5m y 15m son la cola de procesos en esos intervalos. Compare con el numero de cores: por encima de ese valor el host no da abasto.',
  memory:
    'used es RAM de procesos. cached y buffered son cache recuperable. free esta libre. Si used crece y cached baja, hay presion de memoria.',
  processes:
    'CPU se muestra como % de un nucleo, como en top. Las barras comparan con el proceso mas alto. RSS es memoria residente. I/O es lectura y escritura a disco.',
  diskIo:
    'read o receive es lectura; write o transmit es escritura, en bytes por segundo. Un pico sostenido indica carga de disco.',
  diskOps:
    'Operaciones de disco por segundo. Muchas ops pequenas saturan el disco aunque el throughput sea bajo.',
  network:
    'RX es trafico que entra y TX el que sale, en bytes por segundo. Sirve para ver si el host consume o sirve datos.',
  packets:
    'Paquetes por segundo en cada direccion. Si suben y el throughput no, hay muchos paquetes pequenos.',
  netFault:
    'errores son fallos de la NIC. descartes son paquetes tirados por cola llena o CPU ocupada. Un valor sostenido merece atencion.',
  tcpConn:
    'Estados TCP. established es trafico activo y listen son puertos a la espera. time_wait o syn altos pueden indicar saturacion, fugas o escaneo.',
  otherConn:
    'Sockets UDP y el resto de protocolos. UDP no tiene handshake; un salto brusco suele ser un servicio nuevo o un flood.',
  volume:
    'Cada punto es un intervalo con logs de la tabla. Pulse uno para filtrarlos. No hay puntos vacios.',
  icewarpSessions:
    'Sesiones servidor actuales por servicio IceWarp (SMTP, IMAP, GroupWare, etc.). Un salto sostenido suele ser clientes o un pico de correo.',
  icewarpMemory:
    'VSZ (memoria virtual) del proceso IceWarp, no RAM residente. IceWarp 14.x lo publica como entero de 32 bits: si pasa de 2 GiB el valor llega negativo y aqui se corrige. Un servicio parado no muestra cifra.',
  icewarpSmtp:
    'Incremento de mensajes SMTP en el rango: recibidos, enviados y fallidos. Son contadores del MIB, no el acumulado desde el arranque.',
  icewarpDefense:
    'Rechazos del SMTP: virus, spam, DNSBL, content filter y tarpit. Sirven para ver si el filtro esta trabajando o si hay un ataque.',
  icewarpKpiServices:
    'Servicios IceWarp en ejecucion segun SNMP (running=1). El total son las filas de la tabla SMTP, POP3, IMAP, IM, GroupWare, FTP y Control.',
  icewarpKpiSessions:
    'Suma de sesiones actuales de todos los servicios (columna SNMP svcServer). No son buzones ni usuarios unicos.',
  icewarpKpiMail:
    'Mensajes SMTP recibidos y enviados en el rango elegido. Es el incremento del contador, no el total historico.',
  icewarpKpiRejected:
    'Suma de rechazos SMTP del rango: fallidos, virus, spam, DNSBL, content filter y tarpit.',
  icewarpKpiPorts:
    'Sonda TCP del agente a los puertos de correo (25, 587, 143, 993, 443). Abierto/cerrado y RTT no vienen de SNMP.',
  icewarpTable:
    'Tabla SNMP de servicios IceWarp. Uptime es TimeTicks (se divide por 100). Virtual es VSZ, no RAM. FTP parado no muestra memoria.',
  icewarpColUptime:
    'Tiempo desde que arranco ese servicio. IceWarp lo manda en TimeTicks (1/100 s); el portal lo convierte a dias y horas.',
  icewarpColSessions:
    'Sesiones servidor abiertas ahora en ese servicio (SMTP, IMAP, Control, etc.).',
  icewarpColPeak: 'Maximo de sesiones servidor desde que arranco el servicio.',
  icewarpColVirtual:
    'Memoria virtual (VSZ) del proceso. No es RSS. Un Control de 2,6 GB virtual suele usar ~100 MB de RAM.',
};
