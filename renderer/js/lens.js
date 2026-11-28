/* Liquid-glass lens: one WebGL canvas under the UI. For every visible `.glass` panel a shader bends the backdrop
   (the aurora) like a convex glass slab: strong refraction near the rim, chromatic fringes and light-following highlights.
   The panels' own CSS backdrop-filter is switched off while the lens is active (html[data-lens="on"]). */
(function (root) {
  'use strict';

  const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const FS = `precision highp float;
uniform vec2 uRes; uniform sampler2D uTex; uniform vec4 uRect; uniform float uRadius, uBevel, uDisp, uAlpha, uSat, uDim;
uniform vec2 uLight; uniform vec4 uTint; uniform float uClear, uBase;
float sd(vec2 p){ vec2 c=uRect.xy+uRect.zw*.5, q=abs(p-c)-uRect.zw*.5+uRadius; return min(max(q.x,q.y),0.)+length(max(q,0.))-uRadius; }
vec4 tex4(vec2 p){ return texture2D(uTex, p/uRes); }
vec3 tex(vec2 p){ return tex4(p).rgb; }
void main(){
  vec2 p=vec2(gl_FragCoord.x, uRes.y-gl_FragCoord.y);
  float d=sd(p);
  float cover=1.-smoothstep(-.6,.8,d);
  if(cover<=0.) discard;
  vec2 g=normalize(vec2(sd(p+vec2(1.,0.))-sd(p-vec2(1.,0.)), sd(p+vec2(0.,1.))-sd(p-vec2(0.,1.)))+1e-5); // outward normal
  float depth=clamp(-d/uBevel,0.,1.);       // 0 at the rim, 1 once past the bevel
  float rim=1.-depth;
  float k=uDisp*rim*rim;                    // bending is strongest where the surface is steepest
  vec3 c;
  c.r=tex(p+g*k*1.00).r; c.g=tex(p+g*k*1.14).g; c.b=tex(p+g*k*1.28).b; // dispersion
  float l=dot(c,vec3(.299,.587,.114));
  c=mix(vec3(l),c,uSat)*uDim;
  c=mix(c,uTint.rgb,uTint.a);
  vec2 L=normalize(uLight);
  float lit=pow(max(dot(g,L),0.),2.), back=pow(max(dot(g,-L),0.),2.);
  float edge=pow(rim,3.);
  c+=vec3(1.)*(lit*edge*.62+back*edge*.3+edge*.05);                       // light-following rim highlights
  c+=vec3(1.)*smoothstep(2.6,0.,-d)*(.16+.30*lit);                         // thin specular edge line
  c+=vec3(1.)*.035*smoothstep(.0,1.,depth);                                // faint body sheen
  if(uClear>.5){
    // see-through window: only the aurora, a dark base and the highlights are painted; the desktop (blurred by the OS) stays visible between them
    float ta=tex4(p+g*k*1.14).a;
    float hi=clamp(lit*edge*.62+back*edge*.3+edge*.05+smoothstep(2.6,0.,-d)*(.16+.30*lit),0.,1.);
    vec3 aur=c;                                    // premultiplied aurora colour (alpha = ta)
    // thinner at the rim (so the glass edge is really see-through), denser in the middle where the text is; even at 0% the body keeps a floor so code stays readable
    float base=mix(uBase*.3, max(uBase,.16), smoothstep(0.,1.,depth));                                // dark glass base so text stays readable over a bright desktop
    float al=clamp(base+ta*.55+uTint.a+hi*.8,0.,1.);
    vec3 col=aur*.6+uTint.rgb*uTint.a+vec3(hi*.8);
    float a2=cover*uAlpha;
    gl_FragColor=vec4(col*a2,al*a2);
    return;
  }
  float a=cover*uAlpha;
  gl_FragColor=vec4(c*a,a);
}`;

  const DIR = [-0.55, -0.83];

  function create({ source }) {
    const out = { supported: false, active: false, setActive() {}, setClear() {}, setBase() {}, mark() {}, refresh() {} };
    const cv = document.createElement('canvas');
    cv.id = 'lensCanvas'; cv.setAttribute('aria-hidden', 'true');
    const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) return out;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram();
    if (!vs || !fs) return out;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return out;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    ['uClear', 'uBase', 'uRes', 'uTex', 'uRect', 'uRadius', 'uBevel', 'uDisp', 'uAlpha', 'uSat', 'uDim', 'uLight', 'uTint'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U.uTex, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);   // keeps the aurora's alpha as premultiplied colour (see-through mode)
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);

    const bgc = document.createElement('canvas'), bgx = bgc.getContext('2d');   // the backdrop as the panels see it: page colour + aurora
    let base = 0.46, clear = false, active = false, dirty = true, raf = 0, sig = '', px = null, lost = false;
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;display:none';
    source.insertAdjacentElement('afterend', cv);

    const tint = () => {
      const cs = getComputedStyle(document.documentElement);
      const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(cs.getPropertyValue('--panel'));
      const light = document.documentElement.dataset.scheme === 'light';
      return { bg: cs.getPropertyValue('--bg').trim() || '#000', rgba: m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] == null ? 1 : +m[4]] : [1, 1, 1, .07], light };
    };

    function draw() {
      raf = 0;
      if (!active || lost) return;
      const dpr = Math.min(devicePixelRatio || 1, 2), W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      gl.viewport(0, 0, W, H);
      gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.SCISSOR_TEST);
      const t = tint();
      const bw = Math.max(2, Math.ceil(innerWidth / 4)), bh = Math.max(2, Math.ceil(innerHeight / 4));
      if (bgc.width !== bw || bgc.height !== bh) { bgc.width = bw; bgc.height = bh; }
      bgx.globalAlpha = 1;
      if (clear) bgx.clearRect(0, 0, bw, bh); else { bgx.fillStyle = t.bg; bgx.fillRect(0, 0, bw, bh); }
      bgx.drawImage(source, 0, 0, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgc);
      gl.uniform2f(U.uRes, W, H); gl.uniform1f(U.uClear, clear ? 1 : 0); gl.uniform1f(U.uBase, base);
      gl.uniform4f(U.uTint, t.rgba[0], t.rgba[1], t.rgba[2], t.rgba[3]);
      gl.uniform1f(U.uSat, 1.55); gl.uniform1f(U.uDim, t.light ? 1 : 0.9);
      document.querySelectorAll('.glass').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const cs = getComputedStyle(el);
        const x = r.left * dpr, y = r.top * dpr, w = r.width * dpr, h = r.height * dpr;
        const rad = Math.min(parseFloat(cs.borderTopLeftRadius) * dpr || 0, w / 2, h / 2);
        gl.scissor(Math.max(0, Math.floor(x - 2)), Math.max(0, Math.floor(H - y - h - 2)), Math.ceil(w + 4), Math.ceil(h + 4));
        gl.uniform4f(U.uRect, x, y, w, h);
        gl.uniform1f(U.uRadius, rad);
        gl.uniform1f(U.uBevel, Math.min(22 * dpr, Math.min(w, h) * 0.3));   // thin panels get a thin bevel, not all rim
        gl.uniform1f(U.uDisp, 40 * dpr);
        gl.uniform1f(U.uAlpha, parseFloat(cs.opacity));
        let lx = DIR[0], ly = DIR[1];
        if (px) { lx = px[0] - (r.left + r.width / 2); ly = px[1] - (r.top + r.height / 2); }
        gl.uniform2f(U.uLight, lx, ly);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      });
      dirty = false;
    }

    // every frame: draw if something asked for it or a panel moved (slide-in, resize, tab switch)
    function loop() {
      if (!active) { raf = 0; return; }
      let s = '';
      document.querySelectorAll('.glass').forEach((el) => { const r = el.getBoundingClientRect(); s += (r.width ? r.left + ',' + r.top + ',' + r.width + ',' + r.height + ',' : '0,'); });
      s += innerWidth + 'x' + innerHeight;
      if (s !== sig) { sig = s; dirty = true; }
      if (dirty) draw();
      raf = requestAnimationFrame(loop);
    }

    addEventListener('pointermove', (e) => { px = [e.clientX, e.clientY]; dirty = true; }, { passive: true });
    addEventListener('resize', () => { dirty = true; });
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; out.setActive(false); });

    out.supported = true;
    root.PFLens.instance = out;   // handy for debugging from the console
    out.mark = () => { dirty = true; };
    out.refresh = () => { dirty = true; };
    out.setBase = (v) => { v = Number(v); base = Math.min(0.8, Math.max(0, isFinite(v) ? v : 0.46)); dirty = true; };
    out.setClear = (v) => { clear = !!v; dirty = true; };
    out.setActive = (on) => {
      on = !!on && !lost;
      document.documentElement.dataset.lens = on ? 'on' : 'off';
      if (on === active) return;
      active = on; out.active = on;
      cv.style.display = on ? 'block' : 'none';
      if (on) { dirty = true; sig = ''; if (!raf) raf = requestAnimationFrame(loop); }
    };
    return out;
  }

  root.PFLens = { create };
})(window);
