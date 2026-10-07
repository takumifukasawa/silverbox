// All DRT columns: +1 EV pre-gain (x2), input peak ≈ 1.41*2 = 2.83.
const PRE = 'let x = max(color * 2.0, vec3f(0.0));\n';
export const DRTS = {
  reinhard: PRE + `
let W = 2.83;
let L = max(luma(x), 1e-6);
let Ld = L * (1.0 + L / (W * W)) / (1.0 + L);
return x * (Ld / L);`,
  sigmoid: PRE + `
let c = 1.5; let s = 0.5264107; let gW = 0.9257334;
let xc = pow(x, vec3f(c));
return (xc / (xc + vec3f(pow(s, c)))) / gW;`,
  agx: PRE + `
let to709 = mat3x3f(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
let to2020 = mat3x3f(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0114, 0.8956);
let agxM = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                   0.0784335999999992, 0.878468636469772, 0.0784336,
                   0.0792237451477643, 0.0791661274605434, 0.879142973793104);
let agxInv = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                     -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                     -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
let minEv = -12.47393; let maxEv = 4.026069;
var v = agxM * max(to709 * x, vec3f(1e-10));
v = clamp(log2(v), vec3f(minEv), vec3f(maxEv));
v = (v - vec3f(minEv)) / (maxEv - minEv);
let v2 = v * v; let v4 = v2 * v2;
v = 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - vec3f(0.00232);
v = agxInv * v;
v = pow(max(v, vec3f(0.0)), vec3f(2.2));
return to2020 * v;`,
  aces: PRE + `
let y = x * 0.6;
return clamp((y * (2.51 * y + vec3f(0.03))) / (y * (2.43 * y + vec3f(0.59)) + vec3f(0.14)), vec3f(0.0), vec3f(1.0));`,
};
