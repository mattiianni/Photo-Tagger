on run
	set appPath to POSIX path of (path to me)
	set rootPath to do shell script "dirname " & quoted form of appPath
	
	-- We force-kill any node process running on port 3001 first, to ensure a clean start with the updated server.js.
	-- Then we run the server in the background and open the browser.
	set bashScript to "export PATH=\"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH\"; " & ¬
		"cd " & quoted form of rootPath & "; " & ¬
		"if ! command -v node >/dev/null; then " & ¬
		"  display alert \"Node.js non trovato\" message \"Assicurati che Node.js sia installato sul Mac.\"; " & ¬
		"  exit 1; " & ¬
		"fi; " & ¬
		"PORT_PID=$(lsof -t -i :3001); " & ¬
		"if [ ! -z \"$PORT_PID\" ]; then " & ¬
		"  kill -9 $PORT_PID; " & ¬
		"  sleep 1; " & ¬
		"fi; " & ¬
		"NODE_BIN=$(command -v node); " & ¬
		"nohup \"$NODE_BIN\" backend/server.js > backend_server.log 2>&1 & " & ¬
		"sleep 1.5; " & ¬
		"open http://localhost:3001"
		
	try
		do shell script bashScript
	on error errMsg
		display alert "Photo Tag Pro Error" message "Errore durante l'avvio: " & errMsg
	end try
end run
