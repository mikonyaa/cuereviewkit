# Security

v0.1.0 is an experimental local tool. The app treats subtitle text, comments, filenames, JSON and ZIPs as untrusted. It uses inert text, escaped standalone HTML, bounded worker computation and decompression, and integrity/revision checks. These checks do not authenticate a reviewer or make history tamper-proof.

For a vulnerability, use the repository's private vulnerability reporting option if available. Otherwise open a minimal issue describing the category without publishing exploit payloads, secrets or real client subtitles. There is no response-time guarantee. A fix will use a new release; published tags/assets will not be silently replaced.

Only tested browser versions are claimed. Keep your browser and Node LTS current. Export a portable package before deleting browser storage. The loopback server serves public app assets only and listens on 127.0.0.1.
