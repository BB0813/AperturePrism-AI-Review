import sys
import paramiko

HOST = "192.168.1.122"
USER = "root"
PASSWORD = "Binbim0813@"

cmd = sys.argv[1]
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(cmd, timeout=600)
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
code = stdout.channel.recv_exit_status()
if out:
    print(out)
if err:
    print("[stderr]", err)
print("[exit]", code)
client.close()
sys.exit(0 if code == 0 else 1)
