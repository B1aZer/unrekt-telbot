// Spiral Galaxy Background - Beautiful animated spiral with glowing particles
let scene, camera, renderer, galaxy;
let time = 0;
const baseRotationSpeed = -0.0005;
const hoverRotationSpeed = -0.005;
let rotationSpeed = baseRotationSpeed;
let targetRotationSpeed = baseRotationSpeed;

function init() {
  scene = new THREE.Scene();
  
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.z = 60;
  
  const canvas = document.getElementById('three-canvas');
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    alpha: true,
    antialias: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  
  createSpiralGalaxy();
  
  window.addEventListener('resize', onResize);
  
  animate();
}

function createSpiralGalaxy() {
  const particleCount = 2000;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);
  const colors = new Float32Array(particleCount * 3);
  const sizes = new Float32Array(particleCount);
  const animations = new Float32Array(particleCount); // For twinkling animation
  
  // Spiral galaxy parameters
  const arms = 3;
  const armSpread = 0.3;
  
  for (let i = 0; i < particleCount; i++) {
    // Distance from center (more particles near center)
    const distance = Math.pow(Math.random(), 0.6) * 80;
    
    // Which spiral arm
    const armIndex = i % arms;
    const armAngle = (armIndex / arms) * Math.PI * 2;
    
    // Spiral angle
    const spiralAngle = distance * 0.2 + armAngle;
    
    // Randomness for natural look
    const randomOffset = (Math.random() - 0.5) * armSpread * (distance * 0.3);
    
    // Position in spiral
    const x = Math.cos(spiralAngle) * distance + randomOffset;
    const y = (Math.random() - 0.5) * 6;
    const z = Math.sin(spiralAngle) * distance + randomOffset;
    
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    
    // Color gradient: cyan near center, purple at edges
    const distanceRatio = distance / 80;
    const colorMix = distanceRatio;
    
    colors[i * 3] = 0.13 + colorMix * 0.52;
    colors[i * 3 + 1] = 0.83 - colorMix * 0.28;
    colors[i * 3 + 2] = 0.93 + colorMix * 0.05;
    
    // Size: bigger near center
    sizes[i] = (1 - distanceRatio) * 4 + 0.5;
    
    // Animation offset for twinkling (each particle twinkles at different rate)
    animations[i] = Math.random() * Math.PI * 2;
  }
  
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('animation', new THREE.BufferAttribute(animations, 1));
  
  // Custom shader material for circular glowing particles
  const vertexShader = `
    attribute float size;
    attribute vec3 color;
    attribute float animation;
    
    varying vec3 vColor;
    varying float vOpacity;
    
    uniform float uTime;
    
    void main() {
      vColor = color;
      
      // Twinkling effect
      float twinkle = sin(uTime * 2.0 + animation * 3.0) * 0.3 + 0.7;
      vOpacity = twinkle;
      
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * (300.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;
  
  const fragmentShader = `
    uniform sampler2D pointTexture;
    varying vec3 vColor;
    varying float vOpacity;
    
    void main() {
      // Create circular particle with soft edges
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      
      // Soft circular shape with glow
      float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
      alpha *= vOpacity;
      
      // Add inner glow
      float innerGlow = 1.0 - smoothstep(0.0, 0.2, dist);
      
      // Combine colors with glow
      vec3 finalColor = vColor + innerGlow * 0.5;
      
      gl_FragColor = vec4(finalColor, alpha);
    }
  `;
  
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }
    },
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  
  galaxy = new THREE.Points(geometry, material);
  galaxy.rotation.x = Math.PI * 0.25;
  
  // Store reference to material for animation
  galaxy.userData.material = material;
  galaxy.userData.originalColors = new Float32Array(colors); // Store original colors
  galaxy.userData.colorTransition = 0; // 0 = original, 1 = gradient
  
  scene.add(galaxy);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  
  time += 0.01;
  
  // Update shader time for twinkling
  if (galaxy.userData.material) {
    galaxy.userData.material.uniforms.uTime.value = time;
  }
  
  // Animate particle positions (subtle floating)
  const positions = galaxy.geometry.attributes.position;
  const originalPositions = galaxy.userData.originalPositions || positions.array.slice();
  
  if (!galaxy.userData.originalPositions) {
    galaxy.userData.originalPositions = originalPositions;
  }
  
  for (let i = 0; i < positions.count; i++) {
    const i3 = i * 3;
    const offset = Math.sin(time * 0.5 + i * 0.01) * 0.3;
    
    positions.array[i3] = originalPositions[i3] + Math.cos(time * 0.3 + i * 0.01) * offset;
    positions.array[i3 + 1] = originalPositions[i3 + 1] + Math.sin(time * 0.4 + i * 0.01) * offset * 0.5;
    positions.array[i3 + 2] = originalPositions[i3 + 2] + Math.cos(time * 0.35 + i * 0.01) * offset;
  }
  positions.needsUpdate = true;
  
  // Smoothly adjust galaxy rotation speed (sped up on CTA hover)
  rotationSpeed += (targetRotationSpeed - rotationSpeed) * 0.08;
  galaxy.rotation.y += rotationSpeed;
  
  renderer.render(scene, camera);
}

// Live Stats Updates
function updateTime() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const secs = String(now.getSeconds()).padStart(2, '0');
  document.getElementById('time').textContent = `${hours}:${mins}:${secs}`;
}


// Animated counter
function animateCounter(element, target, duration = 2000) {
  const start = 0;
  const startTime = performance.now();
  
  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(start + (target - start) * eased);
    
    if (target >= 1000000) {
      element.textContent = (current / 1000000).toFixed(1) + 'M+';
    } else if (target >= 1000) {
      element.textContent = (current / 1000).toFixed(0) + 'K';
    } else {
      element.textContent = current.toLocaleString();
    }
    
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  
  requestAnimationFrame(update);
}

// Update galaxy colors based on transition value
function updateGalaxyColors() {
  if (!galaxy || !galaxy.userData.originalColors) return;
  
  const colors = galaxy.geometry.attributes.color;
  const originalColors = galaxy.userData.originalColors;
  const transition = galaxy.userData.colorTransition;
  
  // Gradient colors (cyan to purple)
  const cyan = { r: 0.20, g: 0.95, b: 1.0 }; // brighter #22d3ee
  const purple = { r: 0.90, g: 0.65, b: 1.10 }; // brighter #a78bfa
  
  for (let i = 0; i < colors.count; i++) {
    const i3 = i * 3;
    const distanceRatio = i / colors.count; // Use particle index for gradient distribution
    
    // Target gradient color for this particle
    const targetR = cyan.r + (purple.r - cyan.r) * distanceRatio;
    const targetG = cyan.g + (purple.g - cyan.g) * distanceRatio;
    const targetB = cyan.b + (purple.b - cyan.b) * distanceRatio;
    
    // Interpolate between original and target
    colors.array[i3] = originalColors[i3] + (targetR - originalColors[i3]) * transition;
    colors.array[i3 + 1] = originalColors[i3 + 1] + (targetG - originalColors[i3 + 1]) * transition;
    colors.array[i3 + 2] = originalColors[i3 + 2] + (targetB - originalColors[i3 + 2]) * transition;
  }
  
  colors.needsUpdate = true;
}

// Smooth color transition animation
function animateColorTransition(targetTransition) {
  const startTransition = galaxy.userData.colorTransition;
  const duration = 800; // ms
  const startTime = performance.now();
  
  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 0.5 - Math.cos(progress * Math.PI) / 2; // Smooth easing
    
    galaxy.userData.colorTransition = startTransition + (targetTransition - startTransition) * eased;
    updateGalaxyColors();
    
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  
  requestAnimationFrame(update);
}

// Initialize everything
document.addEventListener('DOMContentLoaded', () => {
  init();
  setInterval(updateTime, 1000);
  updateTime();
  
  // Animate volume counters after delay
  setTimeout(() => {
    const counters = document.querySelectorAll('.counter');
    counters.forEach(counter => {
      if (counter.dataset.target) {
        animateCounter(counter, parseInt(counter.dataset.target));
      }
    });
  }, 1800);
  
  // Button hover effect - change galaxy colors (only for Live Demo button)
  const ctaButton = document.querySelector('.cta:not(.cta-whitepaper)');
  if (ctaButton) {
    ctaButton.addEventListener('mouseenter', () => {
      animateColorTransition(1); // Transition to gradient colors
      targetRotationSpeed = hoverRotationSpeed;
    });
    
    ctaButton.addEventListener('mouseleave', () => {
      animateColorTransition(0); // Transition back to original colors
      targetRotationSpeed = baseRotationSpeed;
    });
  }
});

