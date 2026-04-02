void function() {
  if (!location.hostname.includes('youtube.com')) {
    alert('Please run this on a YouTube page.');
    return;
  }

  // YouTube enforces Trusted Types - create a policy to allow our script
  let policy;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      policy = window.trustedTypes.createPolicy('lens-bm', {
        createHTML: function(s) { return s; }
      });
    } catch(e) {
      // Policy might already exist from a previous click
    }
  }

  function safeHTML(s) {
    return policy ? policy.createHTML(s) : s;
  }

  // Extract YouTube innertube config from the page
  var apiKey = null, clientVersion = null, visitorData = null;
  var scripts = document.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) {
    var text = scripts[i].textContent;
    var km = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (km) apiKey = km[1];
    var vm = text.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
    if (vm) clientVersion = vm[1];
    var vd = text.match(/"VISITOR_DATA":"([^"]+)"/);
    if (vd) visitorData = vd[1];
  }

  if (!apiKey || !clientVersion) {
    alert('Could not find YouTube API config on this page. Try reloading the page first.');
    return;
  }

  // Remove existing overlay if present
  var existing = document.getElementById('lens-add-video-overlay');
  if (existing) existing.remove();

  // Create overlay UI
  var overlay = document.createElement('div');
  overlay.id = 'lens-add-video-overlay';
  overlay.innerHTML = safeHTML(
    '<style>' +
    '#lens-add-video-overlay {' +
    '  position: fixed; top: 0; right: 0; width: 420px; height: 100vh;' +
    '  background: #1a1a2e; color: #e0e0e0; font-family: system-ui, sans-serif;' +
    '  z-index: 999999; box-shadow: -4px 0 24px rgba(0,0,0,0.5);' +
    '  display: flex; flex-direction: column; font-size: 14px;' +
    '}' +
    '#lens-av-header {' +
    '  padding: 16px; background: #16213e; border-bottom: 1px solid #333;' +
    '  display: flex; justify-content: space-between; align-items: center;' +
    '}' +
    '#lens-av-header h2 { margin: 0; font-size: 16px; color: #fff; }' +
    '#lens-av-close {' +
    '  background: none; border: none; color: #888; font-size: 20px;' +
    '  cursor: pointer; padding: 4px 8px;' +
    '}' +
    '#lens-av-close:hover { color: #fff; }' +
    '#lens-av-body { padding: 16px; flex: 1; overflow-y: auto; }' +
    '#lens-av-urls {' +
    '  width: 100%; min-height: 100px; background: #0f0f23; color: #e0e0e0;' +
    '  border: 1px solid #444; border-radius: 6px; padding: 10px;' +
    '  font-family: monospace; font-size: 13px; resize: vertical; box-sizing: border-box;' +
    '}' +
    '#lens-av-urls::placeholder { color: #666; }' +
    '.lens-av-btn {' +
    '  background: #4361ee; color: white; border: none; border-radius: 6px;' +
    '  padding: 10px 20px; cursor: pointer; font-size: 14px; font-weight: 500;' +
    '  width: 100%; margin-top: 12px;' +
    '}' +
    '.lens-av-btn:hover { background: #3a56d4; }' +
    '.lens-av-btn:disabled { background: #555; cursor: not-allowed; }' +
    '#lens-av-status { margin-top: 16px; }' +
    '.lens-av-job {' +
    '  background: #0f0f23; border-radius: 6px; padding: 10px; margin-bottom: 8px;' +
    '  border-left: 3px solid #444;' +
    '}' +
    '.lens-av-job.queued { border-left-color: #888; }' +
    '.lens-av-job.fetching { border-left-color: #f0ad4e; }' +
    '.lens-av-job.done { border-left-color: #5cb85c; }' +
    '.lens-av-job.error { border-left-color: #d9534f; }' +
    '.lens-av-job-title { font-weight: 500; margin-bottom: 4px; }' +
    '.lens-av-job-detail { font-size: 12px; color: #888; margin-bottom: 6px; }' +
    '.lens-av-job-preview {' +
    '  font-size: 12px; color: #aaa; background: #0a0a1a; padding: 8px;' +
    '  border-radius: 4px; max-height: 80px; overflow-y: auto;' +
    '  line-height: 1.4; white-space: pre-wrap; margin-top: 6px;' +
    '}' +
    '.lens-av-section-label { font-size: 12px; color: #888; margin-bottom: 6px; }' +
    '#lens-av-confirm { background: #2ecc71; margin-top: 12px; }' +
    '#lens-av-confirm:hover { background: #27ae60; }' +
    '#lens-av-confirm:disabled { background: #555; }' +
    '</style>' +
    '<div id="lens-av-header">' +
    '  <h2>Add to Lens</h2>' +
    '  <button id="lens-av-close">\u00d7</button>' +
    '</div>' +
    '<div id="lens-av-body">' +
    '  <div class="lens-av-section-label">YouTube URLs (one per line)</div>' +
    '  <textarea id="lens-av-urls" placeholder="Paste YouTube URLs here, or leave empty to use the current video..."></textarea>' +
    '  <button class="lens-av-btn" id="lens-av-fetch">Fetch Transcripts</button>' +
    '  <div id="lens-av-status"></div>' +
    '  <button class="lens-av-btn" id="lens-av-confirm" style="display:none;" disabled>Send to Lens</button>' +
    '</div>'
  );
  document.body.appendChild(overlay);

  // Pre-fill with current video URL if on a watch page
  var urlParams = new URLSearchParams(location.search);
  var currentVideoId = urlParams.get('v');
  if (currentVideoId) {
    document.getElementById('lens-av-urls').value = location.href;
  }

  document.getElementById('lens-av-close').onclick = function() { overlay.remove(); };

  // Extract plain text preview from transcript raw data
  function getTranscriptPreview(transcriptRaw, maxChars) {
    var events = (transcriptRaw.events || []).filter(function(e) { return e.segs; });
    var words = [];
    for (var i = 0; i < events.length; i++) {
      var segs = events[i].segs || [];
      for (var j = 0; j < segs.length; j++) {
        var text = (segs[j].utf8 || '').replace(/\n/g, ' ');
        if (text.trim()) words.push(text);
      }
    }
    var full = words.join('').replace(/\s+/g, ' ').trim();
    if (full.length > maxChars) {
      return full.substring(0, maxChars) + '...';
    }
    return full;
  }

  // Parse video IDs from URLs
  function parseVideoIds(text) {
    var lines = text.trim().split('\n');
    var ids = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var m = line.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
      if (m) ids.push(m[1]);
    }
    // Dedupe
    return ids.filter(function(id, idx) { return ids.indexOf(id) === idx; });
  }

  // Fetch transcript for a single video
  function fetchTranscript(videoId) {
    return fetch('https://www.youtube.com/youtubei/v1/player?key=' + apiKey + '&prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: clientVersion,
            visitorData: visitorData
          }
        }
      })
    })
    .then(function(resp) {
      if (!resp.ok) throw new Error('Player API returned ' + resp.status);
      return resp.json();
    })
    .then(function(playerData) {
      var title = (playerData.videoDetails && playerData.videoDetails.title) || 'Unknown';
      var channel = (playerData.videoDetails && playerData.videoDetails.author) || 'Unknown';
      var tracks = playerData.captions &&
        playerData.captions.playerCaptionsTracklistRenderer &&
        playerData.captions.playerCaptionsTracklistRenderer.captionTracks;

      if (!tracks || tracks.length === 0) {
        throw new Error('No captions available for this video');
      }

      // Prefer English track
      var enTrack = null;
      for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].languageCode === 'en') { enTrack = tracks[i]; break; }
      }
      if (!enTrack) enTrack = tracks[0];

      return fetch(enTrack.baseUrl + '&fmt=json3', { credentials: 'include' })
        .then(function(resp) {
          if (!resp.ok) throw new Error('Transcript fetch returned ' + resp.status);
          return resp.json();
        })
        .then(function(transcriptData) {
          var events = (transcriptData.events || []).filter(function(e) { return e.segs; });
          if (events.length === 0) throw new Error('Transcript returned no word data');

          return {
            video_id: videoId,
            title: title,
            channel: channel,
            url: 'https://www.youtube.com/watch?v=' + videoId,
            transcript_type: enTrack.kind === 'asr' ? 'word_level' : 'sentence_level',
            track_lang: enTrack.languageCode,
            transcript_raw: transcriptData,
            word_event_count: events.length
          };
        });
    });
  }

  // State
  var results = [];

  // Fetch button handler
  document.getElementById('lens-av-fetch').onclick = function() {
    var btn = this;
    var videoIds = parseVideoIds(document.getElementById('lens-av-urls').value);

    if (videoIds.length === 0) {
      alert('No valid YouTube URLs found. Paste URLs like:\nhttps://www.youtube.com/watch?v=Nl7-bRFSZBs');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Fetching...';
    var statusDiv = document.getElementById('lens-av-status');
    statusDiv.innerHTML = safeHTML('');
    results.length = 0;

    // Create job entries
    var jobs = videoIds.map(function(id) {
      return { id: id, el: null, status: 'queued', data: null, error: null };
    });

    jobs.forEach(function(job) {
      var el = document.createElement('div');
      el.className = 'lens-av-job queued';
      el.innerHTML = safeHTML(
        '<div class="lens-av-job-title">' + job.id + '</div>' +
        '<div class="lens-av-job-detail">Queued</div>'
      );
      statusDiv.appendChild(el);
      job.el = el;
    });

    // Process sequentially
    var idx = 0;
    function processNext() {
      if (idx >= jobs.length) {
        btn.disabled = false;
        btn.textContent = 'Fetch Transcripts';
        if (results.length > 0) {
          var confirmBtn = document.getElementById('lens-av-confirm');
          confirmBtn.style.display = 'block';
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Send ' + results.length + ' transcript' + (results.length > 1 ? 's' : '') + ' to Lens';
        }
        return;
      }

      var job = jobs[idx];
      job.el.className = 'lens-av-job fetching';
      job.el.querySelector('.lens-av-job-detail').textContent = 'Fetching transcript...';

      fetchTranscript(job.id)
        .then(function(data) {
          job.data = data;
          job.status = 'done';
          job.el.className = 'lens-av-job done';
          job.el.querySelector('.lens-av-job-title').textContent = data.title;
          job.el.querySelector('.lens-av-job-detail').textContent =
            data.channel + ' | ' + data.transcript_type + ' | ' + data.word_event_count + ' segments';
          var sampleEvents = (data.transcript_raw.events || []).filter(function(e) { return e.segs; }).slice(0, 5);
          var previewEl = document.createElement('div');
          previewEl.className = 'lens-av-job-preview';
          previewEl.textContent = JSON.stringify(sampleEvents, null, 1);
          job.el.appendChild(previewEl);
          results.push(data);
        })
        .catch(function(e) {
          job.status = 'error';
          job.error = e.message;
          job.el.className = 'lens-av-job error';
          job.el.querySelector('.lens-av-job-detail').textContent = 'Error: ' + e.message;
        })
        .then(function() {
          idx++;
          if (idx < jobs.length) {
            setTimeout(processNext, 1000);
          } else {
            processNext();
          }
        });
    }

    processNext();
  };

  // Confirm/send button handler
  document.getElementById('lens-av-confirm').onclick = function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Sending...';

    var payload = results.map(function(r) {
      return {
        video_id: r.video_id,
        title: r.title,
        channel: r.channel,
        url: r.url,
        transcript_type: r.transcript_type,
        transcript_raw: r.transcript_raw
      };
    });

    var totalSize = JSON.stringify(payload).length;
    var summary = results.map(function(r) {
      return '- ' + r.title + ' (' + r.channel + '): ' + r.word_event_count + ' segments';
    }).join('\n');

    alert(
      'Prototype: would POST ' + results.length + ' transcript(s) to server.\n\n' +
      'Payload size: ' + (totalSize / 1024).toFixed(0) + ' KB\n\n' +
      summary
    );

    btn.textContent = 'Send ' + results.length + ' transcript' + (results.length > 1 ? 's' : '') + ' to Lens';
    btn.disabled = false;
  };
}();
