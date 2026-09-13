import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';

// 1. シーン・カメラ・レンダラー
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 3000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
document.body.appendChild(renderer.domElement);

// 2. ライト
const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
directionalLight.position.set(100, 200, 100);
scene.add(directionalLight);
scene.add(new THREE.AmbientLight(0x707070));

// 3. 海
const oceanGeo = new THREE.PlaneGeometry(3000, 3000);
const oceanMat = new THREE.MeshLambertMaterial({ color: 0x1e90ff });
const ocean = new THREE.Mesh(oceanGeo, oceanMat);
ocean.rotation.x = -Math.PI / 2;
const SEA_LEVEL = 0;
ocean.position.y = SEA_LEVEL;
scene.add(ocean);

// --- 疑似ノイズ生成（島の名前から固定シードを作り、毎回同じいびつな形になるようにする） ---
function hashStringToSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harmonic { freq: number; amp: number; phase: number; }

function makeHarmonics(seed: number): Harmonic[] {
  const rand = mulberry32(seed);
  const freqs = [3, 5, 7, 11];
  return freqs.map((f) => ({
    freq: f,
    amp: (0.16 / f) * (0.6 + rand() * 0.8),
    phase: rand() * Math.PI * 2,
  }));
}

// --- 島データ ---
// ★ radiusは設計書の面積(㎡)から逆算した正確な数値
interface IslandBase {
  name: string; x: number; z: number; radius: number; color: number; height: number;
}

const islandBases: IslandBase[] = [
  { name: 'グリーンアイランド', x: 0, z: 0, radius: 272, color: 0x3cb371, height: 4 },          // 面積232638 / 中央
  { name: 'フォレストアイランド', x: 620, z: 0, radius: 200, color: 0x2e4f24, height: 6 },        // 面積125527 / 真東
  { name: 'オールドシティアイランド', x: 0, z: 780, radius: 137, color: 0xc2b280, height: 4 },    // 面積58832 / はるか南
  { name: 'マウンテンアイランド', x: 500, z: -500, radius: 146, color: 0x808080, height: 35 },   // 面積67280 / 北東
  { name: 'スゥイートアイランド', x: -500, z: -500, radius: 205, color: 0xffb6c1, height: 6 },   // 面積131675 / 北西
];

interface IslandData extends IslandBase { harmonics: Harmonic[]; }

const islands: IslandData[] = islandBases.map((b) => ({
  ...b,
  harmonics: makeHarmonics(hashStringToSeed(b.name)),
}));

// Blender製のGreen Island。読み込み後は見た目と当たり判定の基準にする。
let blenderGroundRoot: THREE.Object3D | null = null;
const blenderGroundBounds = new THREE.Box3();
const blenderGroundRaycaster = new THREE.Raycaster();
const blenderGroundRayOrigin = new THREE.Vector3();
const blenderGroundRayDirection = new THREE.Vector3(0, -1, 0);
let proceduralTerrainMesh: THREE.Mesh | null = null;

// 角度(ラジアン)ごとに、その方向の海岸線までの半径を返す（いびつな海岸線の本体）
function getIslandRadiusAt(isl: IslandData, angle: number): number {
  let mod = 0;
  for (const har of isl.harmonics) {
    mod += har.amp * Math.sin(har.freq * angle + har.phase);
  }
  mod = Math.max(-0.18, Math.min(0.18, mod)); // 最大±18%までのいびつさに制限（島同士の衝突防止）
  return isl.radius * (1 + mod);
}

// 島ごとに「坂の幅」を高さに応じて自動計算（高い山ほど緩やかな坂にする）
function getEdgeWidth(isl: IslandData): number {
  const minEdge = 20;
  const targetSlope = 0.28;
  return Math.max(minEdge, isl.height / targetSlope / 2);
}

// 地形の高さ関数（見た目のメッシュも、当たり判定も、現在地判定も、この関数系だけを使う）
function getTerrainHeightAt(x: number, z: number): number {
  // Green IslandにBlender地面がある場合は、GLBそのものをレイキャストして高さを取る。
  // これにより「見た目はGLB、当たり判定は古い地形」というズレを防ぐ。
  if (blenderGroundRoot) {
    const min = blenderGroundBounds.min;
    const max = blenderGroundBounds.max;
    const margin = 1;
    if (x >= min.x - margin && x <= max.x + margin && z >= min.z - margin && z <= max.z + margin) {
      blenderGroundRayOrigin.set(x, max.y + 50, z);
      blenderGroundRaycaster.set(blenderGroundRayOrigin, blenderGroundRayDirection);
      const hits = blenderGroundRaycaster.intersectObject(blenderGroundRoot, true);
      if (hits.length > 0) return hits[0].point.y;
    }
  }

  // Blender地面がない島は従来のプロシージャル地形を使う。
  let maxHeight = 0;
  for (const isl of islands) {
    const dx = x - isl.x;
    const dz = z - isl.z;
    const dist = Math.hypot(dx, dz);
    const angle = Math.atan2(dz, dx);
    const localRadius = getIslandRadiusAt(isl, angle);
    const edge = getEdgeWidth(isl);
    let h = 0;
    if (dist <= localRadius - edge) {
      h = isl.height;
    } else if (dist <= localRadius + edge) {
      const t = (dist - (localRadius - edge)) / (edge * 2);
      h = isl.height * (1 - t);
    }
    if (h > maxHeight) maxHeight = h;
  }
  return maxHeight;
}

function getCurrentIslandName(x: number, z: number): string {
  for (const isl of islands) {
    const dx = x - isl.x;
    const dz = z - isl.z;
    const dist = Math.hypot(dx, dz);
    const angle = Math.atan2(dz, dx);
    const localRadius = getIslandRadiusAt(isl, angle);
    if (dist <= localRadius) return isl.name;
  }
  return '海の上';
}

// 見た目の地形メッシュを高さマップから生成（当たり判定と完全一致させる）
function buildTerrainMesh(excludeGreenIsland = false): THREE.Mesh {
  const size = 2200;
  const segments = 160;
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const posAttr = geo.attributes.position;
  const colors: number[] = [];
  const tempColor = new THREE.Color();
  const seaFloorColor = new THREE.Color(0x0b3d63);
  const greenIsland = islands[0];

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);

    let h = getTerrainHeightAt(x, z);
    let bestColor = seaFloorColor;
    let bestHeight = 0;

    // groud1.glbを使う場合、旧Green Islandの地面は完全に非表示にする。
    // ここを残すと「古い地面＋Blender地面」が重なってしまう。
    let insideBlenderGreenArea = false;
    if (excludeGreenIsland) {
      const dx = x - greenIsland.x;
      const dz = z - greenIsland.z;
      const dist = Math.hypot(dx, dz);
      const angle = Math.atan2(dz, dx);
      const localRadius = getIslandRadiusAt(greenIsland, angle);
      const edge = getEdgeWidth(greenIsland);
      insideBlenderGreenArea = dist <= localRadius + edge;
      if (insideBlenderGreenArea) {
        h = SEA_LEVEL;
      }
    }

    posAttr.setY(i, h);

    if (!insideBlenderGreenArea) {
      for (const isl of islands) {
        if (excludeGreenIsland && isl.name === 'グリーンアイランド') continue;
        const dx = x - isl.x;
        const dz = z - isl.z;
        const dist = Math.hypot(dx, dz);
        const angle = Math.atan2(dz, dx);
        const localRadius = getIslandRadiusAt(isl, angle);
        const edge = getEdgeWidth(isl);
        if (dist <= localRadius + edge) {
          let hh = 0;
          if (dist <= localRadius - edge) hh = isl.height;
          else hh = isl.height * (1 - (dist - (localRadius - edge)) / (edge * 2));
          if (hh > bestHeight) {
            bestHeight = hh;
            tempColor.setHex(isl.color);
            bestColor = tempColor.clone();
          }
        }
      }
    }

    colors.push(bestColor.r, bestColor.g, bestColor.b);
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geo, mat);
}


// --- 4. プレイヤー（頭・胴体・両手・両足） ---
const playerGroup = new THREE.Group();

const skinMat = new THREE.MeshLambertMaterial({ color: 0xffdbac });
const shirtMat = new THREE.MeshLambertMaterial({ color: 0xe74c3c });
const pantsMat = new THREE.MeshLambertMaterial({ color: 0x2c3e50 });

const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), skinMat);
head.position.y = 1.75;
playerGroup.add(head);

const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.3), shirtMat);
torso.position.y = 1.15;
playerGroup.add(torso);

const leftLegGroup = new THREE.Group();
leftLegGroup.position.set(-0.18, 0.8, 0);
const leftLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), pantsMat);
leftLegMesh.position.y = -0.4;
leftLegGroup.add(leftLegMesh);
playerGroup.add(leftLegGroup);

const rightLegGroup = new THREE.Group();
rightLegGroup.position.set(0.18, 0.8, 0);
const rightLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), pantsMat);
rightLegMesh.position.y = -0.4;
rightLegGroup.add(rightLegMesh);
playerGroup.add(rightLegGroup);

const leftArmGroup = new THREE.Group();
leftArmGroup.position.set(-0.42, 1.4, 0);
const leftArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), skinMat);
leftArmMesh.position.y = -0.35;
leftArmGroup.add(leftArmMesh);
playerGroup.add(leftArmGroup);

const rightArmGroup = new THREE.Group();
rightArmGroup.position.set(0.42, 1.4, 0);
const rightArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), skinMat);
rightArmMesh.position.y = -0.35;
rightArmGroup.add(rightArmMesh);
playerGroup.add(rightArmGroup);

playerGroup.position.set(0, 4, 0);
scene.add(playerGroup);

// --- 5. ステータス ＆ UI ---
let hp = 100;
let thirst = 100;
let hunger = 100;

const hpBar = document.getElementById('hp-bar')!;
const hpVal = document.getElementById('hp-val')!;
const thirstBar = document.getElementById('thirst-val-bar')!;
const thirstVal = document.getElementById('thirst-val')!;
const hungerBar = document.getElementById('hunger-bar')!;
const hungerVal = document.getElementById('hunger-val')!;
const interactPrompt = document.getElementById('interact-prompt')!;
const islandNameUI = document.getElementById('island-name')!;
const viewModeText = document.getElementById('view-mode-text')!;

function updateUI() {
  hpBar.style.width = `${Math.max(0, hp)}%`;
  hpVal.innerText = `${Math.ceil(Math.max(0, hp))}`;
  thirstBar.style.width = `${Math.max(0, thirst)}%`;
  thirstVal.innerText = `${Math.ceil(Math.max(0, thirst))}`;
  hungerBar.style.width = `${Math.max(0, hunger)}%`;
  hungerVal.innerText = `${Math.ceil(Math.max(0, hunger))}`;
}

// --- リソース（木・石） ---
interface HarvestEffectParticle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
}

const harvestEffectParticles: HarvestEffectParticle[] = [];

interface FloatingDamage {
  element: HTMLDivElement;
  worldPosition: THREE.Vector3;
  life: number;
  maxLife: number;
}
const floatingDamages: FloatingDamage[] = [];

const combatStyle = document.createElement('style');
combatStyle.textContent = `
  .floating-damage {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    color: #fff;
    font: 900 28px Arial, sans-serif;
    text-shadow: 0 2px 0 #000, 0 0 6px #000;
    transform: translate(-50%, -50%) scale(1.15);
    transition: opacity 0.08s linear;
  }
  .attack-flash {
    position: fixed;
    left: 50%;
    top: 50%;
    width: 24px;
    height: 24px;
    margin: -12px;
    border: 3px solid #fff;
    border-radius: 50%;
    box-shadow: 0 0 14px #fff;
    pointer-events: none;
    z-index: 999;
    opacity: 0;
  }
`;
document.head.appendChild(combatStyle);

const attackFlash = document.createElement('div');
attackFlash.className = 'attack-flash';
document.body.appendChild(attackFlash);

const crosshair = document.createElement('div');
crosshair.id = 'game-crosshair';
crosshair.style.cssText = 'position:fixed;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);pointer-events:none;z-index:998;';
const crosshairStyle = document.createElement('style');
crosshairStyle.textContent = `
#game-crosshair::before,#game-crosshair::after,#game-crosshair span::before,#game-crosshair span::after{content:'';position:absolute;background:#fff;box-shadow:0 0 3px #000}
#game-crosshair::before{width:2px;height:7px;left:10px;top:0}
#game-crosshair::after{width:2px;height:7px;left:10px;bottom:0}
#game-crosshair span:first-child::before{width:7px;height:2px;left:0;top:10px}
#game-crosshair span:first-child::after{width:7px;height:2px;right:0;top:10px}`;
document.head.appendChild(crosshairStyle);
crosshair.innerHTML = '<span></span>';
document.body.appendChild(crosshair);

function showDamageNumber(target: THREE.Object3D, damage: number) {
  const element = document.createElement('div');
  element.className = 'floating-damage';
  element.textContent = String(damage);
  document.body.appendChild(element);
  floatingDamages.push({
    element,
    worldPosition: (() => {
      const box = new THREE.Box3().setFromObject(target);
      const p = new THREE.Vector3(
        (box.min.x + box.max.x) * 0.5,
        box.max.y + 0.15,
        (box.min.z + box.max.z) * 0.5
      );
      return p;
    })(),
    life: 0.8,
    maxLife: 0.8,
  });
}

function playAttackEffect(target: THREE.Object3D) {
  attackFlash.style.opacity = '1';
  attackFlash.style.transform = 'translate(-50%, -50%) scale(0.65)';
  window.setTimeout(() => {
    attackFlash.style.opacity = '0';
    attackFlash.style.transform = 'translate(-50%, -50%) scale(1.5)';
  }, 70);

  const originalScale = target.scale.clone();
  target.scale.multiplyScalar(1.08);
  window.setTimeout(() => target.scale.copy(originalScale), 90);

  const arm = rightArmGroup;
  const originalRotation = arm.rotation.x;
  arm.rotation.x = -1.25;
  window.setTimeout(() => { arm.rotation.x = originalRotation; }, 130);
}

function spawnWoodHitEffect(node: ResourceNode) {
  const base = node.mesh.position.clone();
  const count = 8;

  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.08, 0.08),
      new THREE.MeshLambertMaterial({ color: 0x8b4513 })
    );

    mesh.position.set(
      base.x + (Math.random() - 0.5) * 0.8,
      base.y + 1.2 + Math.random() * 2.5,
      base.z + (Math.random() - 0.5) * 0.8
    );
    scene.add(mesh);

    harvestEffectParticles.push({
      mesh,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.12,
        0.08 + Math.random() * 0.08,
        (Math.random() - 0.5) * 0.12
      ),
      life: 0.35 + Math.random() * 0.25,
    });
  }
}

interface ResourceNode {
  mesh: THREE.Group | THREE.Mesh;
  name: string;
  itemId: string;
  itemName: string;
  yieldCount: number;
  health: number;
  maxHealth: number;
  radius: number;
  resourceType: 'tree' | 'rock' | 'pickup';
  resourceSize: 'small' | 'normal' | 'large';
  islandName: string;
}

interface WeaponStats {
  name: string;
  vsCreature: number;
  vsBuilding: number;
  vsResource: number;
}

// 武器ダメージ
const weaponStats: Record<string, WeaponStats> = {
  stone: { name: '石', vsCreature: 2, vsBuilding: 2, vsResource: 2 },
  hammer: { name: 'ハンマー', vsCreature: 5, vsBuilding: 3, vsResource: 5 },
  wooden_spear: { name: '木槍', vsCreature: 7, vsBuilding: 5, vsResource: 1 },
  stone_spear: { name: '石槍', vsCreature: 11, vsBuilding: 8, vsResource: 1 },
  iron_spear: { name: '鉄槍', vsCreature: 15, vsBuilding: 12, vsResource: 1 },
  iron_axe: { name: '鉄斧', vsCreature: 10, vsBuilding: 8, vsResource: 8 },
  iron_pickaxe: { name: '鉄ピッケル', vsCreature: 10, vsBuilding: 8, vsResource: 8 },
};

const resourceNodes: ResourceNode[] = [];

// Blenderで作成した木モデル（public/wood1.glb）を共有して使う。
// すべての木で同じジオメトリを共有することで、木が大量にあっても無駄な読み込みを避ける。
const gltfLoader = new GLTFLoader();
let woodModelTemplate: THREE.Group | null = null;
let rockModelTemplate: THREE.Group | null = null;
let groundModelTemplate: THREE.Group | null = null;

const treeDurability: Record<ResourceNode['resourceSize'], number> = {
  small: 50,
  normal: 100,
  large: 150,
};

const rockDurability: Record<ResourceNode['resourceSize'], number> = {
  small: 75,
  normal: 100,
  large: 125,
};

function getResourceSizeName(size: ResourceNode['resourceSize']): string {
  if (size === 'small') return '小さい';
  if (size === 'large') return '大きい';
  return '普通の';
}

function getTreeSize(): ResourceNode['resourceSize'] {
  const r = Math.random();
  if (r < 0.35) return 'small';
  if (r < 0.85) return 'normal';
  return 'large';
}

function getRockSize(): ResourceNode['resourceSize'] {
  const r = Math.random();
  if (r < 0.35) return 'small';
  if (r < 0.85) return 'normal';
  return 'large';
}

function createTreeResource(
  x: number,
  groundY: number,
  z: number,
  size: ResourceNode['resourceSize']
): ResourceNode {
  // wood1.glbが読み込まれていればBlender製モデルを使用する。
  // 念のため、モデルが存在しない場合は従来の簡易モデルを使う。
  const sizeScale = size === 'small' ? 0.7 : size === 'large' ? 1.35 : 1.0;
  let group: THREE.Group;

  if (woodModelTemplate) {
    group = woodModelTemplate.clone(true);
    group.scale.multiplyScalar(sizeScale);

    // Blender側の原点が木の根元からずれていても、地面に接するように補正する。
    const box = new THREE.Box3().setFromObject(group);
    const minY = box.min.y;
    group.position.set(x, groundY - minY, z);
  } else {
    group = new THREE.Group();

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.65 * sizeScale, 0.85 * sizeScale, 8 * sizeScale, 8),
      new THREE.MeshLambertMaterial({ color: 0x8b4513 })
    );
    trunk.position.y = 4 * sizeScale;
    group.add(trunk);

    const leaves = new THREE.Mesh(
      new THREE.ConeGeometry(3.5 * sizeScale, 7.5 * sizeScale, 10),
      new THREE.MeshLambertMaterial({ color: 0x228b22 })
    );
    leaves.position.y = 9 * sizeScale;
    group.add(leaves);

    group.position.set(x, groundY, z);
  }

  scene.add(group);

  const health = treeDurability[size];
  const node: ResourceNode = {
    mesh: group,
    name: `${getResourceSizeName(size)}木`,
    itemId: 'wood',
    itemName: '木材',
    yieldCount: size === 'large' ? 10 : size === 'normal' ? 5 : 3,
    health,
    maxHealth: health,
    radius: 0.8 * sizeScale,
    resourceType: 'tree',
    resourceSize: size,
    islandName: getCurrentIslandName(x, z),
  };
  group.traverse((child) => { child.userData.resourceNode = node; });
  return node;
}

function createRockResource(
  x: number,
  groundY: number,
  z: number,
  size: ResourceNode['resourceSize']
): ResourceNode {
  const sizeScale = size === 'small' ? 0.65 : size === 'large' ? 1.45 : 1.0;
  let mesh: THREE.Group | THREE.Mesh;

  if (rockModelTemplate) {
    const group = rockModelTemplate.clone(true);
    group.scale.multiplyScalar(sizeScale);

    // stone1.glbの原点が岩の中心などになっていても、岩の底面が地面に接するように補正する。
    const box = new THREE.Box3().setFromObject(group);
    const minY = box.min.y;
    group.position.set(x, groundY - minY, z);
    mesh = group;
  } else {
    // stone1.glbが読み込めなかった場合の従来モデル。
    const fallback = new THREE.Mesh(
      new THREE.DodecahedronGeometry(1.2 * sizeScale, 1),
      new THREE.MeshLambertMaterial({ color: 0x708090 })
    );
    fallback.position.set(x, groundY + 0.6 * sizeScale, z);
    mesh = fallback;
  }

  scene.add(mesh);

  const health = rockDurability[size];
  const node: ResourceNode = {
    mesh,
    name: `${getResourceSizeName(size)}岩`,
    itemId: 'stone',
    itemName: '石',
    yieldCount: size === 'large' ? 6 : size === 'normal' ? 3 : 2,
    health,
    maxHealth: health,
    radius: 1.2 * sizeScale,
    resourceType: 'rock',
    resourceSize: size,
    islandName: getCurrentIslandName(x, z),
  };
  mesh.traverse((child) => { child.userData.resourceNode = node; });
  return node;
}

function createPickupResource(
  x: number,
  groundY: number,
  z: number,
  itemId: string,
  itemName: string,
  amount: number,
  islandName: string
): ResourceNode {
  const colors: Record<string, number> = {
    leaf: 0x3fa34d,
    high_grade_wood: 0x6b3f20,
    hide: 0xd2b48c,
    clay: 0xb66a50,
    iron_fragment: 0x9aa0a6,
    berry: 0xd94b6b,
    mushroom: 0xc8b24a,
  };

  // 拾える資源は1個の立体メッシュにまとめる。見た目を保ちつつ描画負荷を抑える。
  let geometry: THREE.BufferGeometry;
  if (itemId === 'leaf' || itemId === 'high_grade_wood') {
    geometry = new THREE.SphereGeometry(0.65, 6, 4);
  } else if (itemId === 'clay') {
    geometry = new THREE.DodecahedronGeometry(0.75, 0);
  } else if (itemId === 'iron_fragment') {
    geometry = new THREE.BoxGeometry(1.0, 0.3, 0.65);
  } else if (itemId === 'berry') {
    geometry = new THREE.IcosahedronGeometry(0.55, 0);
  } else if (itemId === 'mushroom') {
    geometry = new THREE.SphereGeometry(0.55, 7, 5);
  } else {
    geometry = new THREE.IcosahedronGeometry(0.6, 0);
  }

  const material = new THREE.MeshLambertMaterial({ color: colors[itemId] ?? 0x7aa35a });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, groundY + 0.35, z);
  mesh.rotation.set(0, Math.random() * Math.PI * 2, itemId === 'leaf' ? 0.35 : 0);

  if (itemId === 'leaf') mesh.scale.set(1.4, 0.3, 0.9);
  else if (itemId === 'iron_fragment') mesh.rotation.z = 0.25;
  else if (itemId === 'mushroom') mesh.scale.y = 0.75;

  scene.add(mesh);
  const node: ResourceNode = {
    mesh,
    name: itemName,
    itemId,
    itemName,
    yieldCount: amount,
    health: 1,
    maxHealth: 1,
    radius: 0.35,
    resourceType: 'pickup',
    resourceSize: 'small',
    islandName,
  };
  mesh.userData.resourceNode = node;
  return node;
}

function randomPointOnIsland(isl: IslandData, margin: number): { x: number; z: number; groundY: number } | null {
  for (let attempt = 0; attempt < 80; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const localRadius = getIslandRadiusAt(isl, angle);
    const usableRadius = Math.max(5, localRadius - margin);
    const r = Math.sqrt(Math.random()) * usableRadius;
    const x = isl.x + Math.cos(angle) * r;
    const z = isl.z + Math.sin(angle) * r;
    const groundY = getTerrainHeightAt(x, z);
    if (groundY >= isl.height - 0.5) return { x, z, groundY };
  }
  return null;
}

function spawnIslandResources(
  isl: IslandData,
  treeCount: number,
  rockCount: number,
  pickupCounts: Record<string, number>
) {
  for (let i = 0; i < treeCount; i++) {
    const point = randomPointOnIsland(isl, 15);
    if (!point) continue;
    const node = createTreeResource(point.x, point.groundY, point.z, getTreeSize());
    node.islandName = isl.name;
    resourceNodes.push(node);
  }

  for (let i = 0; i < rockCount; i++) {
    const point = randomPointOnIsland(isl, 12);
    if (!point) continue;
    const node = createRockResource(point.x, point.groundY, point.z, getRockSize());
    node.islandName = isl.name;
    resourceNodes.push(node);
  }

  for (const [itemId, count] of Object.entries(pickupCounts)) {
    const names: Record<string, string> = {
      leaf: '葉', high_grade_wood: '高級木材', hide: '皮', clay: '粘土', iron_fragment: '鉄の破片', berry: 'ベリー', mushroom: 'キノコ'
    };
    for (let i = 0; i < count; i++) {
      const point = randomPointOnIsland(isl, 8);
      if (!point) continue;
      const amount = itemId === 'leaf' ? 3 + Math.floor(Math.random() * 5) : 1 + Math.floor(Math.random() * 3);
      resourceNodes.push(createPickupResource(point.x, point.groundY, point.z, itemId, names[itemId] ?? itemId, amount, isl.name));
    }
  }
}

// 設計に合わせた島ごとの資源配分。
// グリーンアイランド：草地を中心に、木・石・基本資源が全部ある。
// フォレストアイランド：木を圧倒的に多くする。
// マウンテンアイランド：石・鉱物を圧倒的に多くする。
// オールドシティ：基本資源に加えて鉄の破片・粘土を多めにする。
// スゥイート：木・石は少なめ、食料系を多めにする。
function spawnAllIslandResources() {
  // グリーンアイランド：草地を中心に、木・石・葉・粘土・食料を幅広く大量配置。
  spawnIslandResources(islands[0], 45, 30, { leaf: 140, clay: 35, berry: 30, mushroom: 15, high_grade_wood: 4 });
  // フォレストアイランド：木を圧倒的に多く、葉も大量。
  spawnIslandResources(islands[1], 240, 35, { leaf: 700, berry: 80, mushroom: 80, clay: 50, high_grade_wood: 40 });
  // オールドシティアイランド：木・石は少なめ、鉄の破片と粘土を大量配置。
  spawnIslandResources(islands[2], 18, 18, { leaf: 60, clay: 160, iron_fragment: 220, hide: 20 });
  // マウンテンアイランド：石を圧倒的に多く、鉄の破片も少し配置。
  spawnIslandResources(islands[3], 22, 220, { leaf: 40, iron_fragment: 120, clay: 55 });
  // スゥイートアイランド：木・石は少なめ、食料系を大量配置。
  spawnIslandResources(islands[4], 18, 22, { leaf: 70, berry: 280, mushroom: 150, clay: 25 });
}


// --- インベントリ ＆ クラフト ---
let isInventoryOpen = false;
const inventoryModal = document.getElementById('inventory-modal')!;
const inventoryGrid = document.getElementById('inventory-grid')!;
const craftList = document.getElementById('craft-list')!;
const hotbarContainer = document.getElementById('hotbar-container')!;

let activeHotbarIndex = 0;

interface InventoryItem { id: string; name: string; count: number; }

const inventoryData: (InventoryItem | null)[] = [
  null, null, null, null, null,
  null, null, null, null, null,
  { id: 'stone', name: '石', count: 1 }, null, null, null, null
];

interface Ingredient { id: string; name: string; count: number; }
interface Recipe { id: string; name: string; resultCount: number; ingredients: Ingredient[]; }

const craftRecipes: Recipe[] = [
  // 基本加工
  { id: 'rope', name: '縄', resultCount: 1, ingredients: [{ id: 'leaf', name: '葉', count: 3 }] },

  // 金属加工
  { id: 'iron_ingot', name: '鉄の延べ棒', resultCount: 1, ingredients: [{ id: 'iron_fragment', name: '鉄の破片', count: 3 }] },

  // 武器・道具
  { id: 'wooden_spear', name: '木槍', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 10 }, { id: 'rope', name: '縄', count: 2 }] },
  { id: 'stone_spear', name: '石槍', resultCount: 1, ingredients: [{ id: 'stone', name: '石', count: 8 }, { id: 'wood', name: '木材', count: 10 }, { id: 'rope', name: '縄', count: 2 }] },
  { id: 'iron_spear', name: '鉄槍', resultCount: 1, ingredients: [{ id: 'iron_ingot', name: '鉄の延べ棒', count: 8 }, { id: 'wood', name: '木材', count: 10 }, { id: 'rope', name: '縄', count: 2 }] },
  { id: 'hammer', name: 'ハンマー', resultCount: 1, ingredients: [{ id: 'stone', name: '石', count: 12 }, { id: 'wood', name: '木材', count: 8 }] },
  { id: 'iron_axe', name: '鉄斧', resultCount: 1, ingredients: [{ id: 'iron_ingot', name: '鉄の延べ棒', count: 10 }, { id: 'wood', name: '木材', count: 8 }, { id: 'rope', name: '縄', count: 2 }] },
  { id: 'iron_pickaxe', name: '鉄ピッケル', resultCount: 1, ingredients: [{ id: 'iron_ingot', name: '鉄の延べ棒', count: 12 }, { id: 'wood', name: '木材', count: 8 }, { id: 'rope', name: '縄', count: 2 }] },

  // 建築
  { id: 'wooden_floor', name: '木の床', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 200 }, { id: 'rope', name: '縄', count: 2 }] },
  { id: 'wooden_wall', name: '木の壁', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 150 }, { id: 'rope', name: '縄', count: 2 }] },
  { id: 'wooden_ceiling', name: '木の天井', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 150 }, { id: 'rope', name: '縄', count: 2 }] },
  { id: 'stone_floor', name: '石の床', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 50 }, { id: 'rope', name: '縄', count: 3 }, { id: 'stone', name: '石', count: 250 }] },
  { id: 'stone_wall', name: '石の壁', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 50 }, { id: 'rope', name: '縄', count: 3 }, { id: 'stone', name: '石', count: 150 }] },
  { id: 'iron_floor', name: '鉄の床', resultCount: 1, ingredients: [{ id: 'high_grade_wood', name: '高級木材', count: 50 }, { id: 'iron_fragment', name: '鉄の破片', count: 100 }, { id: 'rope', name: '縄', count: 5 }] },
  { id: 'iron_wall', name: '鉄の壁', resultCount: 1, ingredients: [{ id: 'high_grade_wood', name: '高級木材', count: 50 }, { id: 'iron_fragment', name: '鉄の破片', count: 100 }, { id: 'rope', name: '縄', count: 5 }] },

  // 拠点設備・防衛・収納
  { id: 'toolbox', name: 'ツールボックス', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 400 }, { id: 'rope', name: '縄', count: 30 }, { id: 'stone', name: '石', count: 50 }] },
  { id: 'campfire', name: '焚火', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 20 }, { id: 'stone', name: '石', count: 30 }] },
  { id: 'furnace', name: 'かまど', resultCount: 1, ingredients: [{ id: 'stone', name: '石', count: 400 }, { id: 'wood', name: '木材', count: 400 }, { id: 'clay', name: '粘土', count: 25 }] },
  { id: 'cooking_station', name: '調理場', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 350 }, { id: 'stone', name: '石', count: 200 }, { id: 'iron_fragment', name: '鉄の破片', count: 100 }, { id: 'rope', name: '縄', count: 3 }] },
  { id: 'workbench', name: '作業台', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 200 }, { id: 'stone', name: '石', count: 50 }, { id: 'rope', name: '縄', count: 3 }] },
  { id: 'water_storage', name: '貯水場', resultCount: 1, ingredients: [{ id: 'high_grade_wood', name: '高級木材', count: 150 }, { id: 'leaf', name: '葉', count: 25 }, { id: 'rope', name: '縄', count: 8 }] },
  { id: 'box', name: '箱', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 80 }] },
  { id: 'shelf', name: '棚', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 150 }] },
  { id: 'lock', name: '鍵', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 75 }, { id: 'rope', name: '縄', count: 1 }] },
  { id: 'tribe_flag', name: '部族旗', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 150 }, { id: 'rope', name: '縄', count: 5 }, { id: 'hide', name: '皮', count: 50 }] },
  { id: 'spikes', name: '棘', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 200 }, { id: 'rope', name: '縄', count: 10 }] },
  { id: 'trap', name: '罠', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 30 }, { id: 'rope', name: '縄', count: 5 }] },
  { id: 'boat', name: 'ボート', resultCount: 1, ingredients: [{ id: 'wood', name: '木材', count: 300 }, { id: 'rope', name: '縄', count: 20 }] },
];

let draggedIndex: number | null = null;

function getIngredientCount(id: string): number {
  return inventoryData.reduce((total, item) => (item && item.id === id ? total + item.count : total), 0);
}

const MAX_RESOURCE_STACK = 1000;

function isStackable(id: string): boolean {
  return !weaponStats[id] && !buildableIds.has(id);
}

function canAddItemToInventory(id: string, amount = 1): boolean {
  if (amount <= 0) return true;
  if (!isStackable(id)) {
    return inventoryData.some((slot) => slot === null);
  }

  let remaining = amount;
  for (const item of inventoryData) {
    if (item?.id === id) remaining -= Math.max(0, MAX_RESOURCE_STACK - item.count);
    if (remaining <= 0) return true;
  }

  const emptySlots = inventoryData.filter((slot) => slot === null).length;
  return remaining <= emptySlots * MAX_RESOURCE_STACK;
}

function canCraft(recipe: Recipe): boolean {
  return canAddItemToInventory(recipe.id, recipe.resultCount)
    && recipe.ingredients.every((ing) => getIngredientCount(ing.id) >= ing.count);
}

function addItemToInventory(id: string, name: string, count: number): boolean {
  if (count <= 0) return true;
  if (!canAddItemToInventory(id, count)) return false;

  if (isStackable(id)) {
    let remaining = count;
    for (const item of inventoryData) {
      if (!item || item.id !== id) continue;
      const space = MAX_RESOURCE_STACK - item.count;
      const moved = Math.min(space, remaining);
      item.count += moved;
      remaining -= moved;
      if (remaining <= 0) return true;
    }

    while (remaining > 0) {
      const emptyIndex = inventoryData.findIndex((slot) => slot === null);
      if (emptyIndex === -1) return false;
      const moved = Math.min(MAX_RESOURCE_STACK, remaining);
      inventoryData[emptyIndex] = { id, name, count: moved };
      remaining -= moved;
    }
    return true;
  }

  const shouldPreferHotbar = !!weaponStats[id] || buildableIds.has(id);
  if (shouldPreferHotbar) {
    const hotbarEmpty = inventoryData.findIndex((slot, index) => index >= 10 && slot === null);
    if (hotbarEmpty !== -1) {
      inventoryData[hotbarEmpty] = { id, name, count: 1 };
      return true;
    }
  }

  const emptyIndex = inventoryData.findIndex((slot) => slot === null);
  if (emptyIndex !== -1) {
    inventoryData[emptyIndex] = { id, name, count: 1 };
    return true;
  }
  return false;
}
function consumeIngredients(ingredients: Ingredient[]) {
  ingredients.forEach((ing) => {
    let needed = ing.count;
    for (let i = 0; i < inventoryData.length; i++) {
      const item = inventoryData[i];
      if (item && item.id === ing.id) {
        if (item.count > needed) { item.count -= needed; needed = 0; break; }
        else { needed -= item.count; inventoryData[i] = null; }
      }
      if (needed <= 0) break;
    }
  });
}
function craftItem(recipe: Recipe) {
  if (!canCraft(recipe)) return;
  consumeIngredients(recipe.ingredients);
  if (!addItemToInventory(recipe.id, recipe.name, recipe.resultCount)) {
    // 容量判定は事前に行っているため通常ここには来ない。
    // 万一失敗した場合でも素材を失わないようにするにはトランザクション化が必要だが、
    // 現状は canCraft と同じ同期状態なので失敗しない。
    return;
  }
  renderUI();
}

function renderUI() {
  inventoryGrid.innerHTML = '';
  inventoryData.forEach((item, index) => {
    const slot = document.createElement('div');
    slot.className = 'inventory-slot';
    if (index >= 10) slot.classList.add('hotbar-linked');
    if (item) { slot.innerText = `${item.name}\nx${item.count}`; slot.draggable = true; }

    slot.addEventListener('dragstart', () => (draggedIndex = index));
    slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('drag-over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('drag-over');
      if (draggedIndex !== null && draggedIndex !== index) {
        const temp = inventoryData[draggedIndex];
        inventoryData[draggedIndex] = inventoryData[index];
        inventoryData[index] = temp;
        renderUI();
      }
    });
    inventoryGrid.appendChild(slot);
  });

  craftList.innerHTML = '';
  craftRecipes.forEach((recipe) => {
    const craftable = canCraft(recipe);
    const costText = recipe.ingredients.map((ing) => `${ing.name}x${ing.count}`).join(', ');
    const itemEl = document.createElement('div');
    itemEl.className = 'craft-item';
    itemEl.innerHTML = `
      <div class="craft-info">
        <div class="craft-name">${recipe.name}</div>
        <div class="craft-cost">必要: ${costText}</div>
      </div>
      <button class="craft-btn" ${craftable ? '' : 'disabled'}>作成</button>
    `;
    itemEl.querySelector('.craft-btn')!.addEventListener('click', () => craftItem(recipe));
    craftList.appendChild(itemEl);
  });

  hotbarContainer.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const item = inventoryData[10 + i];
    const hotbarSlot = document.createElement('div');
    hotbarSlot.className = 'hotbar-slot';
    if (i === activeHotbarIndex) hotbarSlot.classList.add('active');
    const weapon = item ? weaponStats[item.id] : null;
    hotbarSlot.innerHTML = `<span class="hotbar-key">${i + 1}</span><span>${item ? `${item.name}<br>x${item.count}${weapon ? `<br>資源:${weapon.vsResource}` : ''}` : ''}</span>`;
    hotbarContainer.appendChild(hotbarSlot);
  }

  if (isBuildMode) {
    interactPrompt.style.display = 'block';
    interactPrompt.innerText = isBuildableSelected()
      ? '[B] 建築モード / 左クリックで設置 / Rで回転'
      : '建築モード：数字キーで建築物を選択してください';
  }
}

function toggleInventory() {
  isInventoryOpen = !isInventoryOpen;
  if (isInventoryOpen) {
    if (isMapOpen) toggleMap();
    inventoryModal.classList.add('active');
    document.exitPointerLock();
  } else {
    inventoryModal.classList.remove('active');
    document.body.requestPointerLock();
  }
}

// --- マップ ---
let isMapOpen = false;
const mapModal = document.getElementById('map-modal')!;
const mapCanvas = document.getElementById('map-canvas') as HTMLCanvasElement;
const mapCtx = mapCanvas.getContext('2d')!;

function toggleMap() {
  isMapOpen = !isMapOpen;
  if (isMapOpen) {
    if (isInventoryOpen) toggleInventory();
    mapModal.classList.add('active');
    document.exitPointerLock();
  } else {
    mapModal.classList.remove('active');
    document.body.requestPointerLock();
  }
}

// いびつな海岸線をそのままミニマップにも描画する
function drawIslandShape(
  isl: IslandData,
  toMapX: (x: number) => number,
  toMapZ: (z: number) => number
) {
  const segments = 64;
  mapCtx.beginPath();
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const r = getIslandRadiusAt(isl, angle);
    const x = isl.x + Math.cos(angle) * r;
    const z = isl.z + Math.sin(angle) * r;
    const mx = toMapX(x);
    const mz = toMapZ(z);
    if (i === 0) mapCtx.moveTo(mx, mz); else mapCtx.lineTo(mx, mz);
  }
  mapCtx.closePath();
}

function drawMap() {
  const w = mapCanvas.width;
  const h = mapCanvas.height;
  mapCtx.clearRect(0, 0, w, h);

  const worldRange = 1050; // 主要5島＋海域を収める表示範囲
  const scale = Math.min(w, h) / (worldRange * 2);
  const toMapX = (x: number) => w / 2 + x * scale;
  const toMapZ = (z: number) => h / 2 + z * scale;

  islands.forEach((isl) => {
    drawIslandShape(isl, toMapX, toMapZ);
    mapCtx.fillStyle = `#${isl.color.toString(16).padStart(6, '0')}`;
    mapCtx.fill();
    mapCtx.strokeStyle = 'rgba(255,255,255,0.4)';
    mapCtx.stroke();

    mapCtx.fillStyle = '#fff';
    mapCtx.font = '12px sans-serif';
    mapCtx.textAlign = 'center';
    mapCtx.fillText(isl.name, toMapX(isl.x), toMapZ(isl.z));
  });

  const px = toMapX(playerGroup.position.x);
  const pz = toMapZ(playerGroup.position.z);
  const facing = playerGroup.rotation.y;

  mapCtx.save();
  mapCtx.translate(px, pz);
  mapCtx.rotate(facing);
  mapCtx.beginPath();
  mapCtx.moveTo(0, -8);
  mapCtx.lineTo(5, 6);
  mapCtx.lineTo(-5, 6);
  mapCtx.closePath();
  mapCtx.fillStyle = '#ffeb3b';
  mapCtx.fill();
  mapCtx.strokeStyle = '#000';
  mapCtx.stroke();
  mapCtx.restore();
}

// --- 採集 ---
let nearestNode: ResourceNode | null = null;

function getSelectedHotbarItem(): InventoryItem | null {
  return inventoryData[10 + activeHotbarIndex];
}

function getSelectedWeapon(): WeaponStats | null {
  const item = getSelectedHotbarItem();
  if (!item) return null;
  return weaponStats[item.id] ?? null;
}

let resourceHitObjects: THREE.Object3D[] = [];
let lastAimCheckAt = 0;
let cachedAimedResource: ResourceNode | null = null;

function rebuildResourceHitObjects() {
  resourceHitObjects = [];
  for (const node of resourceNodes) {
    node.mesh.traverse((child) => resourceHitObjects.push(child));
  }
}

function getAimedResourceNode(force = false): ResourceNode | null {
  const now = performance.now();
  if (!force && now - lastAimCheckAt < 80) return cachedAimedResource;
  lastAimCheckAt = now;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  raycaster.far = 8;

  const hits = raycaster.intersectObjects(resourceHitObjects, false);
  cachedAimedResource = null;

  for (const hit of hits) {
    const node = hit.object.userData.resourceNode as ResourceNode | undefined;
    if (node) {
      cachedAimedResource = node;
      break;
    }
  }

  return cachedAimedResource;
}

function checkInteractions() {
  if (isBuildMode || isSwimming) return;
  nearestNode = getAimedResourceNode();

  const weapon = getSelectedWeapon();
  const selectedItem = getSelectedHotbarItem();

  if (nearestNode) {
    interactPrompt.style.display = 'block';
    if (nearestNode.resourceType === 'pickup') {
      interactPrompt.innerText = `[F] ${nearestNode.itemName}を拾う（${nearestNode.yieldCount}個）`;
    } else if (weapon) {
      interactPrompt.innerText = `[左クリック] ${weapon.name}で${nearestNode.name}を攻撃（${weapon.vsResource}ダメージ / 耐久 ${nearestNode.health}/${nearestNode.maxHealth}）`;
    } else if (selectedItem) {
      interactPrompt.innerText = `${selectedItem.name}では資源を攻撃できません`;
    } else {
      interactPrompt.innerText = '武器を選択してください（1〜5）';
    }
  } else {
    interactPrompt.style.display = 'none';
  }
}

// 攻撃間隔。クリック連打で毎フレームのように採集できないようにする。
const ATTACK_COOLDOWN_MS = 1000;
let lastAttackAt = -Infinity;

function disposeObject3D(object: THREE.Object3D) {
  // Blender製木モデルは全インスタンスでジオメトリ・マテリアルを共有しているため、
  // 1本削除するたびに共有アセットをdisposeすると残りの木が壊れてしまう。
  if (object.userData.sharedAsset) return;

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();

    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
  });
}

function attackNearestNode() {
  if (isSwimming || isInventoryOpen || isMapOpen) return;

  const now = performance.now();
  if (now - lastAttackAt < ATTACK_COOLDOWN_MS) return;

  nearestNode = getAimedResourceNode();
  if (!nearestNode || nearestNode.resourceType === 'pickup') return;

  const weapon = getSelectedWeapon();
  if (!weapon) return;

  const damage = weapon.vsResource;

  // 資源は「壊した瞬間」にだけ獲得する。
  // 最後の一撃でインベントリが満杯になる場合は、耐久を減らさない。
  if (nearestNode.health - damage <= 0 && !canAddItemToInventory(nearestNode.itemId, nearestNode.yieldCount)) {
    interactPrompt.style.display = 'block';
    interactPrompt.innerText = 'インベントリが満杯です。空きを作ってください';
    return;
  }

  lastAttackAt = now;
  nearestNode.health -= damage;

  if (nearestNode.resourceType === 'tree') spawnWoodHitEffect(nearestNode);
  playAttackEffect(nearestNode.mesh);
  showDamageNumber(nearestNode.mesh, damage);

  if (nearestNode.health <= 0) {
    if (!addItemToInventory(nearestNode.itemId, nearestNode.itemName, nearestNode.yieldCount)) {
      // 上の容量チェックと同一フレームなので通常は発生しない。
      nearestNode.health = 1;
      return;
    }

    scene.remove(nearestNode.mesh);
    disposeObject3D(nearestNode.mesh);

    const index = resourceNodes.indexOf(nearestNode);
    if (index !== -1) resourceNodes.splice(index, 1);
    rebuildResourceHitObjects();
    cachedAimedResource = null;

    nearestNode = null;
    interactPrompt.style.display = 'none';
    renderUI();
    return;
  }

  renderUI();
  checkInteractions();
}

function resolveObjectCollisions(newX: number, newZ: number): { x: number; z: number } {
  const playerRadius = 0.5;
  let resolvedX = newX;
  let resolvedZ = newZ;

  // 資源との衝突
  for (const node of resourceNodes) {
    if (node.resourceType === 'pickup') continue;
    const dx = resolvedX - node.mesh.position.x;
    const dz = resolvedZ - node.mesh.position.z;
    const distSq = dx * dx + dz * dz;
    const minDist = playerRadius + node.radius;
    if (distSq < minDist * minDist && distSq > 0.000001) {
      const dist = Math.sqrt(distSq);
      const overlap = minDist - dist;
      resolvedX += (dx / dist) * overlap;
      resolvedZ += (dz / dist) * overlap;
    }
  }

  // 建築物との衝突。床・天井は上下方向の判定で処理するため、ここでは通行を妨げない。
  for (const building of placedBuildings) {
    if (building.id.includes('floor') || building.id === 'wooden_ceiling') continue;

    const { halfX, halfZ } = getBuildingHorizontalHalfExtents(building);
    const dxWorld = resolvedX - building.mesh.position.x;
    const dzWorld = resolvedZ - building.mesh.position.z;
    const cos = Math.cos(building.mesh.rotation.y);
    const sin = Math.sin(building.mesh.rotation.y);
    const localX = dxWorld * cos + dzWorld * sin;
    const localZ = -dxWorld * sin + dzWorld * cos;
    const closestX = Math.max(-halfX, Math.min(halfX, localX));
    const closestZ = Math.max(-halfZ, Math.min(halfZ, localZ));
    const pushX = localX - closestX;
    const pushZ = localZ - closestZ;
    const distSq = pushX * pushX + pushZ * pushZ;

    if (distSq < playerRadius * playerRadius) {
      if (distSq > 0.000001) {
        const dist = Math.sqrt(distSq);
        const push = playerRadius - dist;
        const normalX = pushX / dist;
        const normalZ = pushZ / dist;
        const worldNX = normalX * cos - normalZ * sin;
        const worldNZ = normalX * sin + normalZ * cos;
        resolvedX += worldNX * push;
        resolvedZ += worldNZ * push;
      } else {
        // プレイヤーが完全に内部に入った場合は最も近い面の外側へ押し出す。
        const toX = halfX - Math.abs(localX);
        const toZ = halfZ - Math.abs(localZ);
        if (toX < toZ) {
          const dir = localX >= 0 ? 1 : -1;
          const worldNX = dir * cos;
          const worldNZ = dir * sin;
          resolvedX += worldNX * (toX + playerRadius);
          resolvedZ += worldNZ * (toX + playerRadius);
        } else {
          const dir = localZ >= 0 ? 1 : -1;
          const worldNX = -dir * sin;
          const worldNZ = dir * cos;
          resolvedX += worldNX * (toZ + playerRadius);
          resolvedZ += worldNZ * (toZ + playerRadius);
        }
      }
    }
  }

  return { x: resolvedX, z: resolvedZ };
}

function getBuildingHorizontalHalfExtents(building: PlacedBuilding): { halfX: number; halfZ: number } {
  const id = building.id;
  if (id.includes('wall')) return { halfX: 2, halfZ: 0.12 };
  if (id.includes('floor') || id === 'wooden_ceiling') return { halfX: 2, halfZ: 2 };
  return { halfX: 1, halfZ: 1 };
}

function getBuildingFloorHeight(x: number, z: number, currentY: number): number {
  let highest = currentY;
  for (const building of placedBuildings) {
    if (!building.id.includes('floor')) continue;
    const dx = x - building.mesh.position.x;
    const dz = z - building.mesh.position.z;
    const cos = Math.cos(building.mesh.rotation.y);
    const sin = Math.sin(building.mesh.rotation.y);
    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    if (Math.abs(localX) <= 2 && Math.abs(localZ) <= 2) {
      const top = building.mesh.position.y + 0.25;
      if (top > highest) highest = top;
    }
  }
  return highest;
}

function getBuildingCeilingBottom(x: number, z: number): number | null {
  let lowest: number | null = null;
  for (const building of placedBuildings) {
    if (building.id !== 'wooden_ceiling') continue;
    const dx = x - building.mesh.position.x;
    const dz = z - building.mesh.position.z;
    const cos = Math.cos(building.mesh.rotation.y);
    const sin = Math.sin(building.mesh.rotation.y);
    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    if (Math.abs(localX) <= 2 && Math.abs(localZ) <= 2) {
      const bottom = building.mesh.position.y - 0.125;
      if (lowest === null || bottom < lowest) lowest = bottom;
    }
  }
  return lowest;
}

// --- 建築 ---
interface PlacedBuilding {
  mesh: THREE.Mesh;
  id: string;
  name: string;
}
const placedBuildings: PlacedBuilding[] = [];
let isBuildMode = false;
let buildRotation = 0;
let buildPreview: THREE.Mesh | null = null;

const buildableIds = new Set(['wooden_floor', 'wooden_wall', 'wooden_ceiling', 'stone_floor', 'stone_wall', 'iron_floor', 'iron_wall', 'campfire', 'furnace', 'cooking_station', 'workbench', 'water_storage', 'box', 'shelf', 'lock', 'tribe_flag', 'spikes', 'trap', 'boat']);

// 初期UI描画は全ての依存関係を初期化した後に行う

function isBuildableSelected(): boolean {
  const item = getSelectedHotbarItem();
  return !!item && buildableIds.has(item.id);
}

function createBuildingMesh(id: string): THREE.Mesh {
  let geometry: THREE.BufferGeometry;
  let material: THREE.Material;

  if (id.includes('wall')) {
    // 壁は十分な高さを確保しつつ、厚さは薄めにする。
    geometry = new THREE.BoxGeometry(4, 4.5, 0.24);
  } else if (id.includes('floor') || id === 'wooden_ceiling') {
    // 床は薄い板ではなく、しっかりした土台として使える厚みにする。
    geometry = new THREE.BoxGeometry(4, 0.5, 4);
  } else {
    geometry = new THREE.BoxGeometry(2, 2, 2);
  }

  const colors: Record<string, number> = {
    wooden_floor: 0x8b5a2b, wooden_wall: 0x8b5a2b, wooden_ceiling: 0x8b5a2b,
    stone_floor: 0x808080, stone_wall: 0x808080,
    iron_floor: 0x555b61, iron_wall: 0x555b61,
    campfire: 0xff7a00, furnace: 0x555555, cooking_station: 0xa66a3f,
    workbench: 0x7b4a22, water_storage: 0x4682b4, box: 0x9b6b3c, shelf: 0x7b4a22,
    lock: 0xc0c0c0, tribe_flag: 0xcc3333, spikes: 0x555555, trap: 0x6b4f2a,
  };
  material = new THREE.MeshLambertMaterial({ color: colors[id] ?? 0x888888, transparent: true, opacity: 0.75 });
  return new THREE.Mesh(geometry, material);
}

function updateBuildPreview() {
  if (!isBuildMode || !isBuildableSelected()) {
    if (buildPreview) { scene.remove(buildPreview); buildPreview = null; }
    return;
  }
  const item = getSelectedHotbarItem()!;
  if (!buildPreview || (buildPreview.userData.id as string) !== item.id) {
    if (buildPreview) scene.remove(buildPreview);
    buildPreview = createBuildingMesh(item.id);
    buildPreview.userData.id = item.id;
    (buildPreview.material as THREE.MeshLambertMaterial).opacity = 0.35;
    scene.add(buildPreview);
  }

  const forward = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
  const pos = playerGroup.position.clone().add(forward.multiplyScalar(5));
  const snappedX = Math.round(pos.x / 2) * 2;
  const snappedZ = Math.round(pos.z / 2) * 2;
  const ground = getTerrainHeightAt(snappedX, snappedZ);
  const support = getBuildingFloorHeight(snappedX, snappedZ, ground);
  const isFloor = item.id.includes('floor');
  const isCeiling = item.id === 'wooden_ceiling';
  const isFlatPiece = isFloor || isCeiling;
  const buildingHeight = item.id.includes('wall') ? 4.5 : (isFlatPiece ? 0.5 : 2);
  const y = isFloor ? support + 0.25 : (isCeiling ? support + 3.0 : support + buildingHeight / 2);
  buildPreview.position.set(snappedX, y, snappedZ);
  buildPreview.rotation.y = buildRotation;

  const valid = canPlaceSelectedBuilding();
  (buildPreview.material as THREE.MeshLambertMaterial).opacity = valid ? 0.35 : 0.12;
}

function canPlaceSelectedBuilding(): boolean {
  if (!buildPreview) return false;
  const item = getSelectedHotbarItem();
  if (!item || item.count <= 0) return false;

  const isFloor = item.id.includes('floor');
  const ground = getTerrainHeightAt(buildPreview.position.x, buildPreview.position.z);

  // ボートだけは海上に置ける。その他の建築物は陸上限定。
  if (item.id === 'boat') return ground <= SEA_LEVEL + 0.05;
  if (ground <= SEA_LEVEL + 0.05) return false;

  // 建築物の中心が既存建築物に重なるのを防ぐ。
  const previewBox = new THREE.Box3().setFromObject(buildPreview);
  for (const building of placedBuildings) {
    const existingBox = new THREE.Box3().setFromObject(building.mesh);

    const horizontalOverlap =
      previewBox.min.x < existingBox.max.x - 0.05 &&
      previewBox.max.x > existingBox.min.x + 0.05 &&
      previewBox.min.z < existingBox.max.z - 0.05 &&
      previewBox.max.z > existingBox.min.z + 0.05;

    const verticalOverlap =
      previewBox.min.y < existingBox.max.y - 0.05 &&
      previewBox.max.y > existingBox.min.y + 0.05;

    if (horizontalOverlap && verticalOverlap) return false;
  }

  // 床以外は地面に置く。既存の建築階層システムはそのまま維持する。
  if (!isFloor && item.id !== 'wooden_ceiling') {
    const expectedY = getBuildingFloorHeight(buildPreview.position.x, buildPreview.position.z, ground) + 1;
    if (Math.abs(buildPreview.position.y - expectedY) > 4.0) return false;
  }

  return true;
}

function placeSelectedBuilding() {
  if (!isBuildMode || !isBuildableSelected()) return;
  const item = getSelectedHotbarItem()!;
  if (!buildPreview || item.count <= 0) return;

  if (!canPlaceSelectedBuilding()) {
    interactPrompt.style.display = 'block';
    interactPrompt.innerText = 'ここには建築できません';
    return;
  }

  const mesh = createBuildingMesh(item.id);
  mesh.position.copy(buildPreview.position);
  mesh.rotation.copy(buildPreview.rotation);
  (mesh.material as THREE.MeshLambertMaterial).opacity = 1;
  scene.add(mesh);
  placedBuildings.push({ mesh, id: item.id, name: item.name });

  item.count -= 1;
  if (item.count <= 0) inventoryData[10 + activeHotbarIndex] = null;
  renderUI();
}

function toggleBuildMode() {
  isBuildMode = !isBuildMode;
  if (isBuildMode) {
    interactPrompt.style.display = 'block';
    interactPrompt.innerText = isBuildableSelected()
      ? '[B] 建築モード / 左クリックで設置 / Rで回転'
      : '建築モード：数字キーで建築物を選択してください';
  } else {
    if (buildPreview) { scene.remove(buildPreview); buildPreview = null; }
    interactPrompt.style.display = 'none';
  }
}

// 6. 操作
const keys: { [key: string]: boolean } = {};
let cameraYaw = 0;
let cameraPitch = 0.2;
const thirdPersonDistance = 8;

let isFirstPerson = false;

let velocityY = 0;
const gravity = -18;
const jumpStrength = 6;
let isGrounded = true;
let walkTime = 0;
let swimTime = 0;
let isSwimming = false;
let jumpWasDown = false;
const SWIM_LEVEL_OFFSET = 0.35;
const SWIM_SPEED = 5.4;

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();

  if (key === 'tab') { e.preventDefault(); toggleInventory(); return; }
  if (key === 'm') { toggleMap(); return; }

  if (key === 'f') {
    const aimed = getAimedResourceNode();
    if (aimed && aimed.resourceType === 'pickup' && addItemToInventory(aimed.itemId, aimed.itemName, aimed.yieldCount)) {
      scene.remove(aimed.mesh);
      const index = resourceNodes.indexOf(aimed);
      if (index !== -1) resourceNodes.splice(index, 1);
      disposeObject3D(aimed.mesh);
      rebuildResourceHitObjects();
      cachedAimedResource = null;
      nearestNode = null;
      renderUI();
      return;
    }
  }

  if (!isInventoryOpen && !isMapOpen && ['1', '2', '3', '4', '5'].includes(key)) {
    activeHotbarIndex = parseInt(key) - 1;
    renderUI();
  }

  if (!isInventoryOpen && !isMapOpen && key === 'y' && !keys['y']) {
    isFirstPerson = !isFirstPerson;
    viewModeText.innerText = isFirstPerson ? '一人称' : '三人称';
  }

  keys[key] = true;
});

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  keys[key] = false;
  if (key === ' ') jumpWasDown = false;
});

let isAttackHeld = false;
let attackInterval: number | null = null;

function startAttackHold() {
  if (isAttackHeld || isInventoryOpen || isMapOpen) return;
  if (document.pointerLockElement !== document.body) {
    document.body.requestPointerLock();
    return;
  }

  isAttackHeld = true;
  attackNearestNode();
  attackInterval = window.setInterval(() => {
    if (!isAttackHeld || isInventoryOpen || isMapOpen) return;
    attackNearestNode();
  }, 50);
}

function stopAttackHold() {
  isAttackHeld = false;
  if (attackInterval !== null) {
    window.clearInterval(attackInterval);
    attackInterval = null;
  }
}

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    if (isBuildMode) {
      placeSelectedBuilding();
    } else {
      startAttackHold();
    }
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'b' && !isInventoryOpen && !isMapOpen) {
    toggleBuildMode();
  }
  if (e.key.toLowerCase() === 'r' && isBuildMode) {
    buildRotation += Math.PI / 2;
  }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) stopAttackHold();
});
window.addEventListener('blur', () => {
  stopAttackHold();
  for (const key of Object.keys(keys)) keys[key] = false;
  jumpWasDown = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === document.body && !isInventoryOpen && !isMapOpen) {
    const sensitivity = 0.002;
    cameraYaw -= e.movementX * sensitivity;
    cameraPitch += e.movementY * sensitivity;

    if (isFirstPerson) {
      cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, cameraPitch));
    } else {
      cameraPitch = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, cameraPitch));
    }
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
});

// 水しぶき：泳いでいることが視覚的に分かるように小さな粒を出す。
let lastSplashAt = 0;
const splashGeometry = new THREE.SphereGeometry(0.09, 5, 3);
const splashMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
function spawnSwimSplash() {
  const now = performance.now();
  if (now - lastSplashAt < 300) return;
  lastSplashAt = now;

  const splash = new THREE.Mesh(splashGeometry, splashMaterial.clone());
  splash.position.set(
    playerGroup.position.x + (Math.random() - 0.5) * 0.8,
    SEA_LEVEL + 0.04,
    playerGroup.position.z + (Math.random() - 0.5) * 0.8
  );
  scene.add(splash);

  const born = now;
  const life = 0.28;
  const tick = () => {
    const progress = (performance.now() - born) / 1000;
    splash.position.y = SEA_LEVEL + 0.04 + progress * 0.5;
    splash.scale.setScalar(1 + progress * 1.2);
    (splash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.7 - progress * 2.2);
    if (progress < life) requestAnimationFrame(tick);
    else {
      scene.remove(splash);
      (splash.material as THREE.Material).dispose();
    }
  };
  requestAnimationFrame(tick);
}

function getSafeThirdPersonCameraPosition(desired: THREE.Vector3): THREE.Vector3 {
  const origin = playerGroup.position.clone();
  origin.y += 1.2;
  const direction = desired.clone().sub(origin);
  const distance = direction.length();
  if (distance <= 0.001) return desired;
  direction.normalize();

  const raycaster = new THREE.Raycaster(origin, direction, 0.1, distance);
  const hits = raycaster.intersectObjects(placedBuildings.map((b) => b.mesh), false);
  if (hits.length > 0) {
    const safeDistance = Math.max(1.0, hits[0].distance - 0.35);
    return origin.clone().add(direction.multiplyScalar(safeDistance));
  }
  return desired;
}

// 7. メインループ
let lastTime = performance.now();

let isDead = false;

function respawnPlayer() {
  hp = 100;
  thirst = 100;
  hunger = 100;
  playerGroup.position.set(0, getTerrainHeightAt(0, 0), 0);
  velocityY = 0;
  isGrounded = true;
  isSwimming = false;
  isDead = false;
  interactPrompt.style.display = 'none';
  updateUI();
}

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const delta = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  const paused = isInventoryOpen || isMapOpen;

  if (!paused) {
    const isSprinting = keys['shift'];
    const inWater = getCurrentIslandName(playerGroup.position.x, playerGroup.position.z) === '海の上';
    const speed = inWater ? SWIM_SPEED : (isSprinting ? 18 : 9);

    if (inWater !== isSwimming) {
      isSwimming = inWater;
      velocityY = 0;
      isGrounded = !isSwimming;
      if (isSwimming) {
        swimTime = 0;
        leftLegGroup.rotation.x = 0;
        rightLegGroup.rotation.x = 0;
        interactPrompt.style.display = 'none';
      }
    }

    thirst -= 0.5 * delta;
    hunger -= 0.3 * delta;
    if (thirst <= 0 || hunger <= 0) hp -= 1.0 * delta;

    hp = Math.max(0, Math.min(100, hp));
    thirst = Math.max(0, Math.min(100, thirst));
    hunger = Math.max(0, Math.min(100, hunger));

    if (hp <= 0 && !isDead) {
      isDead = true;
      stopAttackHold();
      respawnPlayer();
    }

    updateUI();
    islandNameUI.innerText = getCurrentIslandName(playerGroup.position.x, playerGroup.position.z);

    let moveX = 0;
    let moveZ = 0;
    const forwardX = -Math.sin(cameraYaw);
    const forwardZ = -Math.cos(cameraYaw);
    const rightX = Math.cos(cameraYaw);
    const rightZ = -Math.sin(cameraYaw);

    if (keys['w'] || keys['arrowup']) { moveX += forwardX; moveZ += forwardZ; }
    if (keys['s'] || keys['arrowdown']) { moveX -= forwardX; moveZ -= forwardZ; }
    if (keys['a'] || keys['arrowleft']) { moveX -= rightX; moveZ -= rightZ; }
    if (keys['d'] || keys['arrowright']) { moveX += rightX; moveZ += rightZ; }

    const isMoving = moveX !== 0 || moveZ !== 0;
    if (isSwimming && isMoving) spawnSwimSplash();

    if (isMoving) {
      const len = Math.hypot(moveX, moveZ);
      const targetX = playerGroup.position.x + (moveX / len) * speed * delta;
      const targetZ = playerGroup.position.z + (moveZ / len) * speed * delta;

      const targetGroundHeight = getTerrainHeightAt(targetX, targetZ);
      if (targetGroundHeight <= SEA_LEVEL + 0.05) {
        // 海は歩けないが、泳いで進める。水中では資源との衝突も無効にする。
        playerGroup.position.x = targetX;
        playerGroup.position.z = targetZ;
      } else {
        const resolved = resolveObjectCollisions(targetX, targetZ);
        playerGroup.position.x = resolved.x;
        playerGroup.position.z = resolved.z;
      }

      if (!isFirstPerson) {
        playerGroup.rotation.y = Math.atan2(-moveX, -moveZ);
      } else {
        playerGroup.rotation.y = cameraYaw;
      }

      walkTime += delta * (isSprinting ? 14 : 9);
      leftLegGroup.rotation.x = Math.sin(walkTime) * 0.6;
      rightLegGroup.rotation.x = -Math.sin(walkTime) * 0.6;
      leftArmGroup.rotation.x = -Math.sin(walkTime) * 0.6;
      rightArmGroup.rotation.x = Math.sin(walkTime) * 0.6;
    } else {
      leftLegGroup.rotation.x = 0;
      rightLegGroup.rotation.x = 0;
      leftArmGroup.rotation.x = 0;
      rightArmGroup.rotation.x = 0;
      if (isFirstPerson) playerGroup.rotation.y = cameraYaw;
    }

    if (!isSwimming) {
      // 陸上のジャンプだけを許可。高さは元の jumpStrength を維持する。
      const jumpPressed = keys[' '] && !jumpWasDown;
      if (jumpPressed && isGrounded) { velocityY = jumpStrength; isGrounded = false; }
      jumpWasDown = keys[' '];

      velocityY += gravity * delta;
      playerGroup.position.y += velocityY * delta;

      const groundHeight = getTerrainHeightAt(playerGroup.position.x, playerGroup.position.z);
      const floorHeight = getBuildingFloorHeight(playerGroup.position.x, playerGroup.position.z, groundHeight);
      const supportHeight = Math.max(groundHeight, floorHeight);
      const ceilingBottom = getBuildingCeilingBottom(playerGroup.position.x, playerGroup.position.z);

      if (playerGroup.position.y <= supportHeight) {
        playerGroup.position.y = supportHeight;
        velocityY = 0;
        isGrounded = true;
      } else if (ceilingBottom !== null && velocityY > 0 && playerGroup.position.y + 2 >= ceilingBottom) {
        playerGroup.position.y = ceilingBottom - 2;
        velocityY = 0;
      }
    } else {
      // 水面付近を泳ぐ。上下に小さく揺らして水泳中であることを表現する。
      swimTime += delta * 4.5;
      const swimBaseY = SEA_LEVEL - SWIM_LEVEL_OFFSET;
      playerGroup.position.y = swimBaseY + Math.sin(swimTime) * 0.12;
      velocityY = 0;
      isGrounded = false;
      const swimming = isMoving;
      if (swimming) {
        leftArmGroup.rotation.x = Math.sin(swimTime * 1.8) * 0.8;
        rightArmGroup.rotation.x = -Math.sin(swimTime * 1.8) * 0.8;
        leftLegGroup.rotation.x = -Math.sin(swimTime * 1.8) * 0.35;
        rightLegGroup.rotation.x = Math.sin(swimTime * 1.8) * 0.35;
      } else {
        leftArmGroup.rotation.x = 0.15;
        rightArmGroup.rotation.x = -0.15;
        leftLegGroup.rotation.x = 0;
        rightLegGroup.rotation.x = 0;
      }
    }

    checkInteractions();
    updateBuildPreview();
  }

  // ダメージ数字を更新
  for (let i = floatingDamages.length - 1; i >= 0; i--) {
    const floating = floatingDamages[i];
    floating.life -= delta;
    floating.worldPosition.y += delta * 1.2;

    const projected = floating.worldPosition.clone().project(camera);
    const visible = projected.z > -1 && projected.z < 1;
    floating.element.style.display = visible ? 'block' : 'none';
    if (visible) {
      floating.element.style.left = `${(projected.x * 0.5 + 0.5) * window.innerWidth}px`;
      floating.element.style.top = `${(-projected.y * 0.5 + 0.5) * window.innerHeight}px`;
      const progress = 1 - floating.life / floating.maxLife;
      floating.element.style.opacity = String(Math.max(0, 1 - progress));
      floating.element.style.transform = `translate(-50%, -50%) translateY(${-progress * 28}px) scale(${1.15 - progress * 0.25})`;
    }

    if (floating.life <= 0) {
      floating.element.remove();
      floatingDamages.splice(i, 1);
    }
  }

  // 木片エフェクトを更新
  for (let i = harvestEffectParticles.length - 1; i >= 0; i--) {
    const particle = harvestEffectParticles[i];
    particle.life -= delta;
    particle.velocity.y -= 0.012 * delta;
    particle.mesh.position.addScaledVector(particle.velocity, delta * 60);
    particle.mesh.rotation.x += 0.15;
    particle.mesh.rotation.y += 0.12;

    if (particle.life <= 0) {
      scene.remove(particle.mesh);
      particle.mesh.geometry.dispose();
      (particle.mesh.material as THREE.Material).dispose();
      harvestEffectParticles.splice(i, 1);
    }
  }

  if (isMapOpen) drawMap();

  const eyeHeight = 1.7;
  if (isFirstPerson) {
    playerGroup.visible = false;
    camera.position.x = playerGroup.position.x;
    camera.position.y = playerGroup.position.y + eyeHeight;
    camera.position.z = playerGroup.position.z;

    const lookTarget = new THREE.Vector3(
      playerGroup.position.x - Math.sin(cameraYaw) * Math.cos(cameraPitch),
      playerGroup.position.y + eyeHeight - Math.sin(cameraPitch),
      playerGroup.position.z - Math.cos(cameraYaw) * Math.cos(cameraPitch)
    );
    camera.lookAt(lookTarget);
  } else {
    playerGroup.visible = true;
    const desiredCamera = new THREE.Vector3(
      playerGroup.position.x + thirdPersonDistance * Math.sin(cameraYaw) * Math.cos(cameraPitch),
      playerGroup.position.y + 1.2 + thirdPersonDistance * Math.sin(cameraPitch),
      playerGroup.position.z + thirdPersonDistance * Math.cos(cameraYaw) * Math.cos(cameraPitch)
    );
    const safeCamera = getSafeThirdPersonCameraPosition(desiredCamera);
    camera.position.copy(safeCamera);
    camera.lookAt(playerGroup.position.x, playerGroup.position.y + 1.2, playerGroup.position.z);
  }

  renderer.render(scene, camera);
}

function loadWoodModel(): Promise<void> {
  return new Promise((resolve) => {
    gltfLoader.load(
      '/wood1.glb',
      (gltf) => {
        woodModelTemplate = gltf.scene;
        woodModelTemplate.userData.sharedAsset = true;

        // Blender側の大きさが多少違っていても、ゲーム内では従来の木と同程度の
        // 高さ（約15）になるように自動調整する。
        const box = new THREE.Box3().setFromObject(woodModelTemplate);
        const height = box.max.y - box.min.y;
        if (height > 0.001) {
          woodModelTemplate.scale.setScalar(15 / height);
        }

        resolve();
      },
      undefined,
      (error) => {
        console.error('wood1.glbの読み込みに失敗しました。従来の木モデルを使用します。', error);
        woodModelTemplate = null;
        resolve();
      }
    );
  });
}

function loadRockModel(): Promise<void> {
  return new Promise((resolve) => {
    gltfLoader.load(
      '/stone1.glb',
      (gltf) => {
        rockModelTemplate = gltf.scene;
        rockModelTemplate.userData.sharedAsset = true;

        // Blender側の大きさが違っていても、ゲーム内では従来の岩と同程度の
        // 高さ（約2.4）になるように自動調整する。
        const box = new THREE.Box3().setFromObject(rockModelTemplate);
        const height = box.max.y - box.min.y;
        if (height > 0.001) {
          rockModelTemplate.scale.setScalar(2.4 / height);
        }

        resolve();
      },
      undefined,
      (error) => {
        console.error('stone1.glbの読み込みに失敗しました。従来の岩モデルを使用します。', error);
        rockModelTemplate = null;
        resolve();
      }
    );
  });
}

async function loadGroundModel(): Promise<void> {
  return new Promise((resolve) => {
    gltfLoader.load(
      '/groud1.glb',
      (gltf) => {
        groundModelTemplate = gltf.scene;
        groundModelTemplate.userData.sharedAsset = true;
        resolve();
      },
      undefined,
      (error) => {
        console.warn('groud1.glb の読み込みに失敗しました。元の地形を使用します。', error);
        groundModelTemplate = null;
        resolve();
      }
    );
  });
}

function addBlenderGround(): void {
  if (!groundModelTemplate) return;

  const greenIsland = islands[0];
  const ground = groundModelTemplate.clone(true);
  ground.name = 'BlenderGround';

  // groud1.glbの実測サイズは約40×40なので、Green Islandの直径544に合わせる。
  // X/Zだけを拡大し、Y方向の起伏はそのまま残す。
  const originalBox = new THREE.Box3().setFromObject(ground);
  const originalSize = originalBox.getSize(new THREE.Vector3());
  const horizontalSize = Math.max(originalSize.x, originalSize.z);
  if (horizontalSize > 0.001) {
    const horizontalScale = (greenIsland.radius * 2) / horizontalSize;
    ground.scale.x *= horizontalScale;
    ground.scale.y *= 4.0;
    ground.scale.z *= horizontalScale;
  }

  // X/Zの中心をGreen Islandの中心(0,0)へ合わせ、最低点を海面へ置く。
  const box = new THREE.Box3().setFromObject(ground);
  const center = box.getCenter(new THREE.Vector3());
  ground.position.x += greenIsland.x - center.x;
  ground.position.z += greenIsland.z - center.z;
  ground.position.y += SEA_LEVEL - box.min.y-132;

  ground.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.blenderGround = true;
    }
  });

  scene.add(ground);
  blenderGroundRoot = ground;
  blenderGroundBounds.setFromObject(ground);
}

async function initializeGame() {
  // Blender製モデルを先に読み込む。groud1.glbがある場合は、Green Islandの旧地面を使わない。
  await Promise.all([loadWoodModel(), loadRockModel(), loadGroundModel()]);

  addBlenderGround();

  // Green Islandだけ旧プロシージャル地面を除外し、残り4島は従来地形を維持する。
  proceduralTerrainMesh = buildTerrainMesh(!!blenderGroundRoot);
  scene.add(proceduralTerrainMesh);

  // GLBの実際の高さを使ってプレイヤーの初期位置も合わせる。
  playerGroup.position.y = getTerrainHeightAt(playerGroup.position.x, playerGroup.position.z);

  spawnAllIslandResources();
  rebuildResourceHitObjects();
  updateUI();
  renderUI();
  animate();
}

initializeGame();
