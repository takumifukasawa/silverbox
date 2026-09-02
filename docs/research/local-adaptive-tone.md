# Local-adaptive tone (LR PV2012 Highlights/Shadows) — design-constraint research

Research note, 2026-09-02. Compiled from web sources by the conductor session; Japanese body preserved verbatim. Feeds the local-adaptive-tone implementation brief (route (b): Fast Local Laplacian) and the E1-E8 LR characterization experiments.

---

# Silverbox: 局所適応 Highlights/Shadows オペレータ — 設計制約リサーチ（統合版）

調査日: 2026-09-01/02。対象: Adobe Lightroom Classic PV 15.4（= Process Version 3 "PV2012" 系譜）、darktable master（リリース 5.6.1, 2026-08-27）、RawTherapee `dev`。

各所見に **【確定事実】**（一次資料の逐語）／**【強い推論】**／**【憶測・コミュニティ】** のラベルを付けています。

---

## 0. エグゼクティブサマリ

**LR PV2012 の Highlights/Shadows が Local Laplacian Filters (LLF) に由来することは、Adobe 公式ブログ・論文著者本人・ACM 公式ビデオ・Adobe 主任科学者の実名発言・査読論文の謝辞という 5 系統の独立した一次情報で裏付けられる【確定事実】。**

さらに実装上決定的な 3 点:

1. **Adobe は "local Laplacian" を明細書に含む米国特許を 1 件も保有していない**（Google Patents 全文検索・FreePatentsOnline 専門検索の双方でゼロ）。SIGGRAPH 2011 での先行公開により新規性を喪失している。**Basic パネルの H/S を直接クレームする Adobe 特許も発見されず。**
2. **著者本人（Sam Hasinoff）の MATLAB 参照実装は MIT ライセンス。** Halide の `apps/local_laplacian`（高速版の完全実装、GPU スケジュール込み）も **MIT**。
3. **vkdt（Johannes Hanika）の `llap` モジュールは BSD-2-Clause の GLSL 実装**で、まさに local Laplacian による shadows/highlights/clarity。**GPU シェーダで書かれた PV2012 型オペレータの唯一の permissive な前例。**

つまりこれは「クリーンルームで手探り」ではなく、**公知アルゴリズムを permissive ライセンスの参照実装から素直に実装し、LR の測定値にパラメータを合わせる**作業です。

**推奨構成**: Fast LLF（輝度離散化版）を log 輝度上で実装 → 低解像度で回して bilateral-grid slicing で full-res 転送。

**ただし LLF だけでは足りません。** Eric Chan は「スライダーの実効レンジが画像コントラストに応じて自動伸縮する」と明言しており【確定事実】、これは素の LLF には無い**第二の適応層**です。OSS にこれを持つ実装は存在しません。ここが校正セッションで最も価値を生む部分です。

---

# 1. Local Laplacian Filters 系譜

## 1.1 論文【確定事実】

| 論文 | URL |
|---|---|
| **Paris, Hasinoff, Kautz**, "Local Laplacian Filters: Edge-aware Image Processing with a Laplacian Pyramid", ACM TOG 30(4) / SIGGRAPH 2011 | [project page](https://people.csail.mit.edu/sparis/publi/2011/siggraph/) · [full PDF 47MB](https://people.csail.mit.edu/sparis/publi/2011/siggraph/Paris_11_Local_Laplacian_Filters.pdf) · [low-res 4.6MB](https://people.csail.mit.edu/sparis/publi/2011/siggraph/Paris_11_Local_Laplacian_Filters_lowres.pdf) · [Adobe Research](https://research.adobe.com/publication/local-laplacian-filters-edge-aware-image-processing-with-a-laplacian-pyramid/) · [ACM DL](https://dl.acm.org/doi/10.1145/2010324.1964963) |
| **Aubry, Paris, Hasinoff, Kautz, Durand**, "Fast and Robust Pyramid-based Image Processing", **MIT-CSAIL-TR-2011-049, 2011-11-15** ← **Adobe が 2012-02 に明示的に併記引用した論文** | [dspace](https://dspace.mit.edu/handle/1721.1/67030) · [PDF](https://dspace.mit.edu/bitstream/handle/1721.1/67030/MIT-CSAIL-TR-2011-049.pdf?sequence=1) |
| 同上 → "Fast Local Laplacian Filters: Theory and Applications", ACM TOG 33(5), 2014 | [project page](https://imagine.enpc.fr/~aubrym/projects/llf/index.html) · [PDF](https://imagine.enpc.fr/~aubrym/projects/llf/texts/2014-fast-laplacian-filter.pdf) · [slides](https://imagine.enpc.fr/~aubrym/projects/llf/data/Aubry_fastLLF_siggraph14.pdf) · [ACM DL](https://dl.acm.org/doi/10.1145/2629645) |
| CACM 再録（2015年3月号、より直感的な解説版） | [ACM DL](https://dl.acm.org/doi/10.1145/2723694) · [著者プレプリント](https://people.csail.mit.edu/sparis/publi/2015/cacm/Paris_15_Local_Laplacian_Filters.pdf) |
| CACM 公式ビデオ（Paris 出演、2015-02-05） | [vimeo.com/118842033](https://vimeo.com/118842033) |

**重要な否定的所見【確定事実】**: 3 本の論文本体（SIGGRAPH 2011 / Fast LLF 2014 / CACM 2015）を全文抽出して確認した結果、**Adobe 製品搭載の記述は一切ありません**（謝辞の "gifts from Microsoft, Google and Adobe" のみ）。Adobe Research の publication ページにも記載なし。製品搭載の主張は §1.5 の 4 箇所にのみ存在します。

## 1.2 コアアルゴリズム（2011）【確定事実・論文本文より】

出力の Laplacian ピラミッドを**係数ごとに独立に**構築する:

```
G ← gaussian_pyramid(I)
for each output coefficient (ℓ0, x0, y0):
    g0 ← G[ℓ0](x0,y0)                      # 局所参照値
    R0 ← 必要な部分領域                     # K = 3(2^(ℓ0+2) − 1)
    R̃0 ← r_{g0,σr}(R0)                     # 点単位リマップを "フル解像度画像" に適用
    L[I'](ℓ0,x0,y0) ← laplacian_pyramid(R̃0)[ℓ0](x0,y0)
L[I'][end] ← G[end]                         # residual は不変
I' ← collapse(L[I'])
```

- 素朴実装は **O(N²)**、部分領域トリックで **O(N log N)**。
- ピラミッドは **Burt–Adelson 5×5 カーネル**（Halide 実装は `[1 3 3 1]`）。

### リマッピング関数

σr が detail と edge を分ける閾値:

```
|i−g0| ≤ σr :  rd(i) = g0 + sign(i−g0) · σr · fd(|i−g0|/σr)
|i−g0| >  σr :  re(i) = g0 + sign(i−g0) · ( fe(|i−g0|−σr) + σr )

detail 操作:  fd(Δ) = Δ^α     (α<1 増強 / α>1 平滑化),  fe(a) = a
tone  操作:  fe(a) = β·a     (β<1 圧縮 / β>1 拡張),   α ≤ 1
```

**連続性の制約**: `rd(g0 ± σr) = re(g0 ± σr)`、かつ r は単調増加でなければならない。

**ノイズ抑制**（α<1 のときのみ）:
```
fd(Δ) = τ·Δ^α + (1−τ)·Δ
τ = 最大輝度の 1% 未満で 0、2% 超で 1 のスムーズステップ
smooth_step(xmin,xmax,x): y = clamp((x−xmin)/(xmax−xmin), 0, 1); return y²·(y−2)²
```

**カラー処理（2 択が本文にある）**:
- **`lum`**: 輝度 `Ii = (20·Ir + 40·Ig + Ib)/61` のみ処理し、色比 `ρ = (Ir,Ig,Ib)/Ii` を後で乗算 ← **トーンマッピングではこちら**
- **`rgb`**: 3D ベクトルとして直接処理
  ```
  rd(i) = g0 + unit(i−g0) · σr · fd(‖i−g0‖/σr)
  re(i) = g0 + unit(i−g0) · [ fe(‖i−g0‖−σr) + σr ]
  unit(v) = v/‖v‖ (v≠0), 0 otherwise
  ```
  （detail を「g0 中心・半径 σr の球内の色」、edge を「球外の色」と定義）

### ★ トーンマッピング時の作用空間【確定事実】— Silverbox の設計判断に直結

> "We apply our filter on the **log intensities** log(Ii) [Tumblin and Turk 1999], using the **natural logarithm**."
>
> "Unless otherwise specified, we use **σr = log(2.5)**, which gave consistently good results in our experiments. Since we work in the log domain, this value corresponds to a **ratio between pixel intensities**. **It does not depend on the dynamic range of the scene**, and assumes only that the input HDR image measures radiance up to scale."
>
> "From a practical standpoint, we advise **keeping σr fixed and varying the slope β** between 0, where the local contrast is responsible for most of the dynamic range, and 1, where the global contrast dominates."

→ **σr = ln(2.5) ≈ 0.916 nat ≈ 1.32 stops**。これがエッジ／ディテール境界の既定値。

出力正規化: log 領域の結果を、**99.5 / 0.5 パーセンタイル**でロバストな max/min を取り、リニア輝度のダイナミックレンジが **100:1** になるようスケール。最後に 1/2.2 ガンマ。

### 論文の推奨パラメータ値【確定事実、`lapfilter_demo.m` より】

| 用途 | σr | α | β | domain |
|---|---|---|---|---|
| detail 強調 | 0.1 / 0.2 / **0.4** | 0.25 / 0.5 / 2 / 4（**0.25** が代表） | 1 | **lin** |
| tone mapping | **2.5**（→ 内部で log(2.5)） | 0.25 / 0.5 / 0.75 / **1** | **0** / 0.3 / 0.6 | **log** |
| inverse tone mapping | 2.5 | 1 | 2.5 | log |

## 1.3 Fast 版のトリック（2011 TR / 2014 TOG）【確定事実】

```
1. G ← gaussian_pyramid(I)
2. 輝度域を {γ_j} で等間隔サンプリング
3. 各 j について remap 画像 r_j(I) とそのラプラシアンピラミッド L[r_j(I)] を事前計算
4. 各係数 (ℓ,x,y):
     g = G[ℓ](x,y) について g = (1−a)·γ_j + a·γ_{j+1} となる (a, j) を求め
     L[O](ℓ,x,y) = (1−a)·L[r_j(I)](ℓ,x,y) + a·L[r_{j+1}(I)](ℓ,x,y)
5. collapse
```

- 事前計算ピラミッド数が固定なので **O(N) 線形**。
- **サンプリング間隔は f の標準偏差 σ ごと**が推奨（f が band-limited なら sampling theorem 上これが最適）。
- 近似精度 **30dB 超**で「実用上区別不能」。
- **メモリ節約版**: 全ピラミッドを同時保持せず、1 本ずつ計算して出力ピラミッドに直接加算していける（出力更新回数は増えるがメモリは 1 本分）。

### Aubry の参照実装（`llf.m`、40 行で全貌が読める）

```matlab
n_levels = ceil(log(min(H,W)) - log(2)) + 2;      % フルピラミッド
discretisation = linspace(0,1,N); step = discretisation(2);
input_gaussian_pyr = gaussian_pyramid(I, n_levels);
output_laplace_pyr = laplacian_pyramid(I, n_levels);   % 元画像の L で初期化
output_laplace_pyr{n_levels} = input_gaussian_pyr{n_levels};
for ref = discretisation
    I_remap = fact*(I-ref).*exp(-(I-ref).^2/(2*sigma^2));   % 微分ガウシアン = 帯域制限
    tmp = laplacian_pyramid(I_remap, n_levels);
    for lev = 1:n_levels-1
        w = (abs(input_gaussian_pyr{lev}-ref) < step) ...
            .* (1 - abs(input_gaussian_pyr{lev}-ref)/step);  % テント補間重み
        output_laplace_pyr{lev} = output_laplace_pyr{lev} + w .* tmp{lev};
    end
end
F = reconstruct_laplacian_pyramid(output_laplace_pyr);
```
デモ既定値: enhancement `sigma=0.1, N=10, fact=5` / smoothing `sigma=0.2, N=5, fact=-1`。

**設計上のポイント**: remap が「差分（x=0 で 0）」なので、出力ピラミッドを元画像の Laplacian で初期化して寄与を**加算**するだけで済む。

## 1.4 性能実測値【確定事実、論文本文】

| 実装 | ハードウェア | 数値 |
|---|---|---|
| 2011 素朴版、1MP、シングルスレッド | 2.26GHz Intel Xeon | **約 60 秒** |
| 同上、中間ピラミッド深さを 5 に制限 | 同上 | 約 30 秒（PSNR 30–40dB） |
| 2011 版、1MP、OpenMP 8 コア | 同上 | **約 4 秒**（8× スピードアップ） |
| **Fast 版、1MP、シングルコア** | 2.66GHz Core i7 | **350 ms**（**50× 高速**） |
| Fast 版、GPU | NVIDIA GeForce GTX 480 | **1MP = 49 ms / 4MP = 116 ms** |
| Halide 版、GPU | NVIDIA Tesla C2070 | 4MP 単チャンネル **49 ms**（さらに約 2×） |
| Halide autotuned（PLDI'13、8 レベル） | quad-core Xeon W3520 / Tesla C2070 | x86 **113 ms**（Adobe 専門家版 189 ms）／CUDA **21 ms** |

**★ 決定的な照合【強い推論】**: Eric Chan が Luminous Landscape で証言した性能推移「**1 メガピクセルあたり約 1 分** → 約 8 秒 → ほぼリアルタイム」は、2011 論文の実測値（60s → 4s on 8 コア）と**完全に一致**します。

## 1.5 ★ Adobe 製品搭載の言明 — 逐語と出典【確定事実、4 系統】

### (1) Adobe Lightroom Journal 公式ブログ — Tom Hogarty（LR プロダクトマネージャ）、2012-02-22

"Magic or Local Laplacian Filters?" — 原 URL は消滅、[Wayback Machine](https://web.archive.org/web/20200918012316/https://blogs.adobe.com/lightroomjournal/2012/02/magic-or-local-laplacian-filters.html) で全文取得済み:

> "The Lightroom and Camera Raw team has been very pleased with all of the positive feedback on the new image processing (**PV2012**) available in the Lightroom 4 beta. (It will also be available in the next major version of the Camera Raw plug-in) **The ability to recover shadow and highlight detail with a straightforward set of controls without introducing artifacts** or over-the-top faux-HDR effects is a huge leap forward in image processing. …
>
> **The cutting edge research in this case is a paper titled, Local Laplacian Filters: Edge-aware Image Processing with a Laplacian Pyramid.** … The team would like to share the praise that we're receiving for the new processing controls with the authors of this research paper:
> Sylvain Paris — Adobe Systems, Inc / Samuel W Hasinoff — Toyota Technological Institute at Chicago and MIT CSAIL / Jan Kautz — University College London
>
> **Note: There is also some contributing knowledge from this paper as well: http://dspace.mit.edu/handle/1721.1/67030**"

**★ この 2 本目が決定的**: MIT-CSAIL-TR-2011-049 = **Fast LLF のプレプリント**（輝度離散化＋線形補間の高速版）。Adobe が 2012 年 2 月時点で両論文を並置引用している事実から、**【強い推論】PV2012 は素の O(N log N) 版ではなく Fast 版を採用している。**

関連: John Nack（Adobe）の同日ピングバック "Secrets of Lightroom 4's excellent imaging"（[Wayback](https://web.archive.org/web/20200803125216/https://blogs.adobe.com/jnack/2012/02/secrets-of-lightroom-4s-excellent-imaging.html)）。

### (2) Sylvain Paris 本人のサイト（Adobe Research）— [people.csail.mit.edu/sparis/](https://people.csail.mit.edu/sparis/)

Products 欄に逐語:

> "**Image Adjustments in Photoshop CS6 (Camera Raw 7), Lightroom 4, and Revel** — The new **Highlights, Shadows, and Clarity** adjustments are **inspired from** our work on local Laplacian filters."

同ページの他の注記:
> "We have implemented local Laplacian filters in **Halide**. This is the fastest implementation that I am aware of."
> "**Hindsight: The fact that our filters produce faithful low-resolution previews** is related to our work on **display-aware image editing**." → [Display-aware Image Editing, ICCP'11](https://jankautz.com/publications/DisplayAwareICCP11.pdf)

※ "inspired from" であって "is" ではない点に留意。

### (3) CACM 公式ビデオ（Paris 出演）— [vimeo.com/118842033](https://vimeo.com/118842033)

> "The parameters for adjusting these filters have been simplified and recombined in the photography software 'Adobe Lightroom', where they appear as **Shadows, Highlights, and Clarity**."

### (4) ★ Halide, PLDI 2013（査読論文）— [PDF](https://people.csail.mit.edu/jrk/halide-pldi13.pdf)

本文 §6:
> "Local Laplacian filters uses a multi-scale approach to tone map images and enhance local contrast in an edge-respecting fashion [3, 22]. **It is used in the clarity, tone mapping, and other filters in Adobe Photoshop and Lightroom.** … The **reference implementation is 262 lines of C++, developed at Adobe**, and carefully parallelized with OpenMP, and offloading most intensive kernels to [GPU]."

謝辞:
> "**Eric Chan provided feedback and inspiration throughout the design of Halide, and helped compare our local Laplacian filters implementation to his in Camera Raw.**"

**→ Adobe の Camera Raw に Eric Chan による local Laplacian filters の実装が存在することの、査読論文における明記。事実上のスモーキングガン。**

同論文からの構造情報【確定事実】: LLF パイプラインは **99 ステージ / 85 ステンシル**、**8 ピラミッドレベル**、down/up は `[1 3 3 1]`、コアは data-dependent access:
```
k ← floor(I1(x,y)/σ);  α ← I1(x,y)/σ − k
O(x,y) ← (1−α)·I2(x,y,k) + α·I2(x,y,k+1)
```

### 主張の境界【重要】

Adobe は **PV2012 の shadow/highlight recovery が LLF に由来する**と述べています。「Highlights スライダーは α/β/σr にマップされた LLF **そのもの**である」とは誰も言っていません。後者は**【強い推論】**であり確定事実ではありません。

## 1.6 参照実装とライセンス【確定事実】

| 実装 | ライセンス | 評価 |
|---|---|---|
| **Paris/Hasinoff 公式 MATLAB (2011)**<br>[matlab_source_code.zip](https://people.csail.mit.edu/sparis/publi/2011/siggraph/matlab_source_code.zip) | **MIT**（同梱 LICENSE: "Copyright (c) 2011 Sam Hasinoff … Permission is hereby granted, free of charge…"） | ★★ **そのまま移植可能**。`lapfilter.m`（remap 定義・色処理・lin/log 領域・後処理）＋ `lapfilter_core.m`（コア、O(N²) naive 版もコメントで同梱）＋ Tom Mertens 由来のピラミッドルーチン |
| **Aubry 公式 MATLAB (2014 Fast 版)**<br>[zip](https://imagine.enpc.fr/~aubrym/projects/llf/code/matlab_fast_llf_and_style_transfer.zip) | **LICENSE ファイルなし**。プロジェクトページは "non-commercial scholarly purposes" | ⚠ **流用不可。読んで再実装する。** `llf.m` は 40 行 |
| **Halide `apps/local_laplacian`**<br>[generator](https://github.com/halide/Halide/blob/main/apps/local_laplacian/local_laplacian_generator.cpp) | **MIT**（[LICENSE.txt](https://github.com/halide/Halide/blob/main/LICENSE.txt) 確認済み。例外: `apps/bgu` のみ Apache-2.0） | ★★ **Fast 版の GPU スケジュール込みの最良の参照。**`pyramid_levels=8`, remap LUT `alpha*x*exp(-x²/2)`, `beta*(gray−level)+level` |
| **vkdt `src/pipe/modules/llap/`**<br>[repo](https://github.com/hanatos/vkdt) | **BSD-2-Clause**（⚠ 要ファイル単位確認、§3.5 参照） | ★★★ **GLSL 実装。WGSL 移植の最有力参照**（詳細 §3.5） |
| `psalvaggio/local_laplacian_filters` (C++/OpenCV) | **MIT** | 2011 素朴版。README に「tone mapping は未テスト」と明記 |
| `hassenkassim/LocalLaplace` | **MIT** | |
| `koszulc/local_laplacian_filter` (Python) | **ライセンスなし** | ⚠ 使用不可 |
| **darktable `src/common/locallaplacian.c` / `.cl`** | **GPL-3.0** | ⚠ **コピー不可・読むだけ**（設計知見は §3.3 で最重要） |
| **OpenCV ximgproc** | Apache-2.0（リポジトリ）／ファイルヘッダは BSD-3 | **local Laplacian は含まれない**（guided / domain transform / bilateral / adaptive manifold / FGS / FBS / L0 はある） |
| **He 本人の guided filter MATLAB** | "academic use only" | ⚠ **使用不可** |

**Web（WebGL/WebGPU/WGSL）の LLF 実装はオープンソースに存在しません**【確定事実、複数経路で確認】。RapidRAW（Rust + wgpu, 9.7k stars, AGPL-3.0）の WGSL シェーダも `blur / display / flare / shader` の 4 本のみで LLF なし。**Web 実装としては実質グリーンフィールド。**

## 1.7 理論的位置づけ（Fast LLF 2014 §2）【確定事実】— 設計判断に有用

remap を `r(i) = i − (i−g)·f(i−g)` と書くと、**2 レベル LLF は「正規化を外した bilateral filter」と厳密に等価**:

```
O_p = I_p + Σ_q  Ḡσp(q−p) · f(I_q − I_p) · (I_q − I_p)        … (10)
```

多スケールでは（D_ℓ = ¯G_{2^(ℓ−1)σp} − ¯G_{2^ℓ σp} は DoG）:
```
L_ℓ[O](p) = Σ_q  D_ℓ(q−p) · f(I_q − g) · (I_q − g)             … (13)
```

**bilateral との本質的な差は 2 点だけ**:
1. **正規化 1/W_p がない** → エッジでの over-sharpening と gradient reversal が消える（論文 Fig.5 が実証）
2. **参照値 g がスケールごとに変わる**（bilateral は常に最細スケールの I_p）

論文の言葉:
> "Bilateral filtering weights all the pixels relatively to the center pixel I_p, i.e., relatively to the finest image scale only. In comparison, the local Laplacian filters **adapt the reference pixel depending on the scale** (Eq. 13), effectively defining a weighting scheme for each scale."

→ **安価な近似が要るなら「unnormalized bilateral filter」がある**（2014 年論文 §2.2 が命名・提案）:
```
UBF_p = I_p + Σ_q  Ḡσs(q−p) · Gσr(I_q − I_p) · (I_q − I_p)     … (14)
```
darktable の local contrast モジュールにも `unnormalized bilateral` モードとして実装されています。

---

# 2. PV2012 Highlights/Shadows について公知のこと

## 2.1 ★ Eric Chan（Adobe Principal Scientist, Camera Raw / Lightroom）本人の逐語発言【確定事実】

出典: [The Phoblographer, Chris Gampat, 2015-08-24](https://www.thephoblographer.com/2015/08/24/youre-probably-not-using-this-feature-of-adobe-lightroom/)
（"This response came from Eric Chan, Adobe Principal Scientist working on Adobe Camera Raw and Lightroom." として全文掲載。ページ本文を直接取得して逐語確認済み。⚠ 私信の再掲であり一次 URL ではない）

> "In the Basic panel, **Highlights and Shadows serve as the primary tone mapping controls. They are sensitive to image content and edges within the image.** They are effective at adjusting overall (global) contrast, **while preserving local contrast.** They are useful for tone mapping high dynamic range (HDR) images. **They automatically expand their effective range when applied to high-contrast images (like HDR images), and automatically reduce their range when applied to low-contrast (e.g., foggy) images.** The underlying mechanism behind Highlights and Shadows is generally known as **"local adaptation," which means that the controls do different things in different parts of the image. It's as if each pixel has its own tone curve.** In short, the Highlights and Shadows controls in the Basic panel are very "dynamic" in nature.
>
> In the Tone Curve panel, Highlights and Shadows are much more straightforward or "direct" controls. They simply adjust a portion of the overall global tone curve. **Unlike the controls of the same name in the Basic panel, the ones in the Tone Curve panel act globally, and do the same thing at every pixel. Their range is always fixed. They do not adapt automatically to image content in any particular way.**"

**これは 2 つの独立した機構を述べています**:
- **機構 A**: 局所適応（= LLF）
- **機構 B**: **画像コントラストに応じたスライダー実効レンジの自動伸縮** ← **素の LLF には無い。OSS にも存在しない。ここが "secret sauce" の本体**

Eric Chan の Adobe 著者ページ: [blog.adobe.com/en/authors/eric-chan](https://blog.adobe.com/en/authors/eric-chan)（Highlights/Shadows/Clarity/Dehaze の担当）

## 2.2 その他の Adobe 側発言【確定事実】

**Adobe 公式インタビュー**, Lex van den Berghe, 2013-07-12 — [blog.adobe.com](https://blog.adobe.com/en/publish/2013/07/12/principal-scientist-and-mad-man-eric-chan-discusses-his-role-in-improving-photoshop)

- 最も誇る仕事: "Probably the **revised tone controls in the Basic panel in Process Version 2012.**"
- 何を作り直したか: "the way we were blending colors for **highlight recovery**, the way we clipped individual color channels for the **Exposure** control, the way we handled (**or rather, ignored**) **strong edges for the Clarity control**"
  → **PV2012 で初めてエッジ認識が入ったことの本人自認。**

**Luminous Landscape**, Charles Cramer, 2013-10-14 — [link](https://luminous-landscape.com/tonal-adjustments-in-the-age-of-lightroom-4/)（Eric Chan 直接取材）

- 逐語引用: "**they had been exploring various algorithms that used edges to modify various tones, but they were incredibly slow.**"
- 性能推移（Cramer のパラフレーズ、【強い推論】）: 当初 **1 メガピクセルあたり約 1 分** → 約 8 秒 → ほぼリアルタイム
- Shadows は Photoshop の Shadows/Highlights に比べ "minimal halo problems"、Highlights は旧 Recovery より "much better job"
- "all six sliders in the Basic panel (from Exposure through Blacks) are now to some extent **image-adaptive**"
- PV2012 の Clarity は PV2010 の約 **3 倍強い**（±32 ≈ ±90 PV2010）

**DPReview**, Martin Evening, 2012-04-23（Adobe ブリーフィング済み）— [link](https://www.dpreview.com/articles/1205103502/extreme-contrast-edits-in-lightroom-4-and-acr-7)

> "most of the PV 2012 controls are **scene adaptive**, meaning their behavior – even at default settings – is **optimized on a per image basis**."
> "The **Contrast slider is now scene-dependent, offsetting its operational midpoint slightly depending on whether you are editing a low key or high key image.**"

→ 「Exposure/Contrast がヒストグラム依存」への最良の具体証拠。

## 2.3 Adobe 公式ドキュメント【確定事実、大半は否定的所見】

- **PV2012 のホワイトペーパーは存在しない。** 公式は [Process versions in Adobe Camera Raw](https://helpx.adobe.com/camera-raw/desktop/get-started/overview-and-setup/process-versions.html)（PV3=2012 は "new tone controls and **new tone-mapping algorithms for high-contrast images**"）と [Tone Control Adjustment](https://helpx.adobe.com/lightroom-classic/help/tone-control-adjustment.html) のみで、アルゴリズム記述なし。
- ⚠ **helpx.adobe.com は本調査環境から到達不能**（403 / タイムアウトを curl・WebFetch・複数ロケールで確認）。検索エンジン経由のスニペットは §2.1 と同一文言を返すため、[Tone Control Adjustment](https://helpx.adobe.com/lightroom-classic/help/tone-control-adjustment.html) が Eric Chan の記述の一次 URL である可能性が高いが、**逐語の裏は現状 The Phoblographer 経由。ブラウザでの直接確認を推奨。**
- Adobe フォーラム [Algorithm of Highlights and Shadow sliders in Lightroom](https://community.adobe.com/t5/lightroom-classic-discussions/algorithm-of-highlights-and-shadow-sliders-in-lightroom/m-p/10085476) — **Adobe 社員の回答なし**。Community Expert: "You won't get that answer from Adobe… it's part of the '**Secret Sauce**'."

### Process Version 系譜【確定事実】

| PV | 導入 | 変更内容 |
|---|---|---|
| PV1 | 2003 | ACR 5.x 以前 |
| PV2 | 2010 | ACR 6、シャープ・NR 改善 |
| **PV3 = "PV2012"** | **ACR 7 / LR4** | **新トーンコントロール＋高コントラスト画像向け新トーンマッピングアルゴリズム** |
| PV4 | ACR 10 / LrC 7 | Range Mask、Auto Mask 改善 |
| PV5 | ACR 11 / LrC 8 | 高 ISO レンダリング、Dehaze 改善 |
| PV6 | **ACR 15.4 / LrC 12.4, 2023-06** | **Color Mixer / B&W Mixer のバンディング低減のみ** |

**→ PV2012 以降、Basic パネルの tone アルゴリズムは変更されていない。PV 15.4 を対象にした校正は PV2012 文献と整合します。**

## 2.4 特許【確定事実（不在の証明を含む）】

> ⚠️ **注意（運用方針の判断が必要）**: 米国では特許を**認識していること自体**が willful infringement のリスクを上げ得ます。以下のいずれも shadows/highlights スライダーを読みませんが、実装担当者に Adobe 特許を読ませるかどうかはプロジェクトとして方針を決めておくべきです。私は法的助言をする立場にありません。

### ★ 最重要の否定的所見

**Adobe は「local Laplacian」を明細書に含む米国特許を 1 件も保有していない。**

- Google Patents 全文 `q="local laplacian"` → Sony US8768069B2、中国の大学、三菱電機のみ。**Adobe ゼロ。**
- FreePatentsOnline `AN/"Adobe" AND SPEC/"local Laplacian"` → **no results**
- 同 `AN/"Adobe" AND SPEC/"local Laplacian filter"` → **no results**（クエリ形を変えて再確認）

**【強い推論】** Adobe は PV2012 Basic パネルの tone mapping コアを特許化していない。SIGGRAPH 2011 で先に公開されたため（第一著者 Sylvain Paris は Adobe 所属）新規性を喪失している。**Basic パネル Highlights/Shadows/Whites/Blacks を直接クレームする Adobe 特許も発見できず**（"not found"）。**FTO 上きわめて有利。**

### 発見された関連 Adobe 特許

| 番号 | タイトル | 発明者 | 優先日/出願 | 登録 | 要旨・評価 |
|---|---|---|---|---|---|
| **US9390484B2**<br>（親 US8831340B2、公開 US20140341468A1） | Methods and apparatus for tone mapping high dynamic range images | Sylvain P. Paris, Jen-Chan Chien, **Eric Chan** | 2010-01-27 / 2014-08-04 | 2016-07-12 | HDR 輝度を **bilateral filter** で base/detail 分解 → detail 層を解析して必要出力レンジを推定 → base を非線形圧縮し上端に detail 用の余地を残す → 再合成。Durand & Dorsey / Bae-Paris-Durand を引用。**局所的だが Laplacian ピラミッドではない。PS の HDR Pro 系であり PV2012 Basic ではない。** [FPO](https://www.freepatentsonline.com/8831340.html) |
| **US9230312B2** | Methods and apparatus for performing tone mapping on HDR images | 同上 | 2010-01-27 / 2012-05-31 | 2016-01-05 | 上記のレイヤ分離出力版（base/detail/color を別レイヤで出力） |
| **US9070044B2**<br>（親 US8666148B2、US9020243） | Image adjustment | Sylvain P. Paris, Frédo P. Durand, Vladimir L. Bychkovsky, **Eric Chan** | 2010-06-03 / 2014-01-20 | 2015-06-30 | MIT-Adobe FiveK の学習型オートトーン。**明示的に "global tonal adjustment"（全画素一様）**。CIE-Lab 輝度の 51 制御点スプライン、1 画像 **266 特徴量**（強度分布、シーン輝度、equalization カーブ、CDF の PCA 上位 5 成分、ハイライトクリップ、顔）→ Gaussian Process 回帰。**Auto Tone 用、局所性なし** |
| **US9251574B2**<br>（継続 US9633421B2、公開 US20150170346A1） | Image compensation value computation | **Eric Chan** ほか | 2013-12-17 | 2016-02-02 | **image key value**（暗部/明部の優勢度）→ power value に写像 → **power mean 統計**が目標に近づくよう補償値を決定し露出に適用。実施例: key 0→6.0, 0.5→1.8, 1.0→−1.0。**画像適応だがグローバル。Auto Tone / 自動露出系** |
| US7853096B1 | Tone selective adjustment of images | Adobe | 2003-10-03 | 2010-12-14 | 旧 Photoshop Shadow/Highlight 系の先行技術 |

**紛らわしいが Adobe ではない特許（要注意）**:
- **US 2012/0219218** "Automatic Localized Adjustment of Image Shadows and Highlights"（タイトル・時期が完全一致するが **Microsoft**）
- **US 9369684 / US 8958658** "Image tone adjustment using local tone curve computation"（**Apple**）

**探索したが該当なし（"not found"）**: `assignee:Adobe` × "highlight recovery" / "edge-aware"+tone / "clarity slider" / TTL "dehaze" / Thomas Knoll 関連（Knoll の Adobe 特許は 1990 年代のディザ・トラップ系と 2023 年以降の HDR gain map のみ）。

**Silverbox への含意**: US9070044 / US9251574 は**既存の Auto tone 実装**の参考として有用（ただし両者とも「グローバル」と明記されている点が重要）。

## 2.5 コミュニティによる解析

### ★ darktable の Lightroom XMP インポータ — 強い間接証拠【確定事実】

`darktable/src/develop/lightroom.c` を実ソース取得して grep:
- ✅ 扱う: `Exposure2012`、`Blacks2012`（テーブル補間 `{-100,0.020},{-50,0.005},{0,0},{50,-0.005},{100,-0.010}`）、`Clarity2012`（`{-100,-.650},{0,0},{100,.650}`）、`ToneCurvePV2012`
- ❌ **一切扱わない: `Highlights2012`, `Shadows2012`, `Whites2012`, `Contrast2012`**

**【強い推論】** darktable は 2013〜2026 を通じ、PV2012 の Highlights/Shadows/Whites/Contrast の写像を**意図的に断念している。グローバルな等価物が存在しないため。**

### pixls.us / フォーラム【コミュニティ】

- [On the topic of Lightroom sliders](https://discuss.pixls.us/t/on-the-topic-of-lightroom-sliders/1809) — RawTherapee メンテナ **Morgan_Hardwood**: "**Lightroom's shadows/highlights sliders do some smart things under the hood, and I know of no libre photo program which has equivalents.**"（⚠ 2018 年の guided filter 改修より前のスレッド）
- ★ [Lightroom "Basic" module equivalents](https://discuss.pixls.us/t/lightroom-basic-module-equivalents/42551)（2024）— **本コーパス中で最良の技術的観察**。bastibe（本人 "IIRC" と留保、【強い推論】）: LR の Basic スライダーは "**spacial** adjustments: they raise and lower exposure in **areas**"、対して darktable の tone equalizer は「輝度帯（tonal）」の操作。**この区別が両者が一致しない理由。** また "IIRC in Lightroom, the first 25% of whites is purely spacial, but beyond starts to lower the actual output white point"
- [Shadows/highlights tool](https://discuss.pixls.us/t/shadows-highlights-tool/7408) — RawTherapee 開発者 agriggio: "I have no idea how the lightroom slider works, but I suspect there's a lot going on behind that simple slider"
- [Darktable shadows and highlights vs tone equalizer](https://discuss.pixls.us/t/darktable-shadows-and-highlights-vs-tone-equalizer/29556)
- [Experimenting with Local Laplacian Filters](https://discuss.pixls.us/t/experimenting-with-local-laplacian-filters/13749) — Carmelo_DrRaw (PhotoFlow), 2019: **log 輝度**で動作、Aubry の高速版ではなく **Paris et al. の原版**を採用、darktable 版の「L>1 でクリップする」点を批判。hanatos が「darktable は clip ではなく quantize、display-referred 空間が対象」と補足。実装は "rather slow, too slow to think about implementing it in PhF"

### Adobe Community Expert（⚠ Adobe 社員ではない。【強い推論】）

- richardplondon: 通常の効果は "solely based on its starting tonal value" だが "**LR further considers whether a pixel of that same starting value, happens to be sitting within a generally light or a generally dark part of the photo**" — [link](https://community.adobe.com/t5/lightroom-classic-discussions/a-question-about-highlights-and-shadows-sliders-in-basic-panel/td-p/10085550)
- Conrad_C: "they **don't just take each pixel and change the value, they analyze surrounding pixels and can alter groups of them**"
- D Fosse: "**the Camera Raw engine is _image adaptive_. This means the entire image is taken into the calculation and the result depends on the whole image.**" ⇔ PS の Shadows/Highlights は "purely 'mechanic'" — [link](https://community.adobe.com/t5/camera-raw-discussions/why-does-camera-raw-act-differently-compared-to-shadows-lights-filter/m-p/14368632)
- Victoria Bampton (Lightroom Queen): "They build a **mask** to limit their effect to specific tones in each individual photo."

### RawDigger / LibRaw【強い推論】

[Deriving Hidden Baseline Exposure Compensation](https://www.rawdigger.com/howtouse/deriving-hidden-ble-compensation)（Iliah Borg）— **PV2012 は PV2010 より線形性が低いため、隠れた BLE の直接測定が困難になった**と明記。→ DNG ベースライン以上の画像依存トーン処理の存在を示唆。LibRaw は ACR レンダリング再現を試みておらず、「DNG は Adobe の**入力**を記述するもので、Adobe の**レンダリング**を記述しない」という立場。

### 測定・カーブプロット — ★ 重要な欠落（"not found"）

**「同じ画素値が周囲によって異なる出力にマップされる」ことを実測・作図した公開資料は存在しません。** 最も近いもの:

- ★ [Fstoppers, Nils Heininger, 2020-12-07](https://fstoppers.com/education/do-you-know-difference-between-basic-adjustments-and-curves-535287) — 5 階調（黒・暗灰・50%灰・明灰・白）に単純化した画像で Shadows を最大に: "**Two of the solid gray areas turned into gradients.**" / "The shadows slider **retains the contrast between the areas by using gradient adjustments depending on the neighboring pixels.**" / Curves では勾配は生じない: "**Curves don't care for the content. Curves don't care about local contrast.**"
  → **平坦パッチが勾配になるのは LLF の教科書的シグネチャ。**
- [Cemal Ekin, PetaPixel 2020-04-13](https://petapixel.com/2020/04/13/tweak-your-curves-for-another-way-to-save-your-highlights/) — ステップウェッジ + Highlights: "**The entire curve starts moving to the left. While the high values move faster, the low values also get somewhat compressed.**"（純粋な帯域分離グローバルカーブでは説明不能）
- [Cemal Ekin, keptlight.com 2011](https://www.keptlight.com/lightroom-exposure-brightness/) — 1200×1200 の黒→白グラデーションを 16 段にポスタライズし、各段の RGB を Excel で記録して Exposure/Brightness の応答をプロット。**方法論の先例として有用だが PV2010 時代**、かつ平坦パッチなので空間依存の検証にならない。
- pixls.us で patdavid が 2016 年にテストパターン比較を提案したが**誰も実行していない**。

**→ Silverbox の測定はこの空白を埋めるものであり、独自の公開価値があります。**

### Jeffrey Friedl

PV2012 トーン数式の解析は **not found**（彼の LR 記事はプラグイン・メタデータ中心）。

## 2.6 Adobe DNG SDK【確定事実】

### 入手とライセンス

- 配布: [helpx.adobe.com/camera-raw/digital-negative.html](https://helpx.adobe.com/camera-raw/digital-negative.html) / [adobe.com/go/dng_sdk](https://www.adobe.com/go/dng_sdk) → **1.7.1 Build 2652 (2026-07-14)**。旧版 [download.adobe.com/pub/adobe/dng/](https://download.adobe.com/pub/adobe/dng/)
- 仕様書: [DNG Specification 1.7.1.0](https://helpx.adobe.com/content/dam/help/en/photoshop/pdf/DNG_Spec_1_7_1_0.pdf)（2023-09、126 ページ）
- **公式 GitHub は存在しない**（`github.com/adobe/dng-sdk` は 404）。第三者ミラー: [hfiguiere/dng_sdk](https://github.com/hfiguiere/dng_sdk)、`CitrusPeel/dng_sdk`（1.7.1 完全版）
- ⚠️ **ライセンス**: "DNG SDK License Agreement"（Adobe 独自、BSD ではない、**OSI 非承認**）。ScanCode 分類 **"Proprietary Free"**、SPDX `LicenseRef-scancode-adobe-dng-sdk`（SPDX 未収載）— [ScanCode entry](https://scancode-licensedb.aboutcode.org/adobe-dng-sdk.html) · [EULA](https://www.adobe.com/support/downloads/dng/dng_sdk_eula_win.html)
  - 許諾条項は BSD 的: "Adobe hereby grants you a **non-exclusive, worldwide, royalty free license to use, reproduce, prepare derivative works from**, publicly display, publicly perform, distribute and sublicense the Software **for any purpose.**"
  - しかし §5 は**商用配布者に Adobe への防御・補償義務**を課す。商標制限あり、違反時終了、ドキュメント改変不可。
  - **→ 読むこと・参考にすることは可。しかし MIT リポジトリに vendoring するとライセンス表示を誤ることになる。**（前例: RawTherapee は GPLv3 でありながら ACR3 デフォルトカーブテーブルをそのまま搭載）

### ★ dng_sdk に局所処理は存在しない — 3 系統の独立証拠

1. **タイル形状**: `dng_render_task::SrcArea(dstArea)` は `return dstArea + fSrcOffset;` — **パディングゼロ**。近傍画素を読むことが構造的に不可能（比較: `dng_resample` / `dng_gain_map` / warp は SrcArea を拡張する）。
2. **内部ループ**: `fTempBuffer` は `tileSize.h × sizeof(real32) × 3` = **RGB 1 行分のみ**。列間・行間の状態を持たない。
3. **全文 grep**: 1.7.1 の全 **159 ソースファイル**に対する `bilateral|laplacian|pyramid|local contrast|local tone|unsharp|guided filter|adaptive tone|dehaze` → **ヒットゼロ**。

唯一の空間依存コードは `dng_gain_map`（周辺減光）、`dng_lens_correction`、`dng_opcodes`。DNG 1.6/1.7 の `ProfileGainTableMap2` と `MaskedRGBTables` は画素位置に依存するが、**ファイルに焼き込まれた LUT を (x,y) でサンプルするだけ**で、レンダラは画像内容から何も計算しない（PGTM 有効時も SrcArea は恒等）。

### SDK の実際のトーン処理

パイプライン（`dng_render_task::ProcessArea`、スキャンライン単位）:
```
camera native → WB × fCameraToRGB → linear ProPhoto → HueSatMap → ProfileGainTableMap
→ fExposureRamp ×3 → LookTable → DoBaselineRGBTone(exposureTone ∘ toneCurve)
→ RGBTables / MaskedRGBTables → ガンマエンコード
```

- **`dng_function_exposure_ramp`**（黒クリップ＋放物線トゥ）: `fSlope = 1/(white−black)`, `fRadius = min(0.5·minBlack, (1/16)/fSlope)`, `fQScale = fSlope/(4·fRadius)`。既定 **black = 0.005**。
- **`dng_function_exposure_tone`**（負の露出補正時のみ、ハイライト保護）: `fSlope = 2^exposure`, `a = 16/9·(1−fSlope)`, `b = fSlope − a/2`, `c = 1−a−b`; `x ≤ 0.25 → x·fSlope`, `x > 0.25 → (a·x+b)·x+c`（f(1)=1 保証）。**SDK 唯一のハイライトロールオフ。**
- **`dng_tone_curve_acr3_default`**: 1025 エントリ固定テーブル（1.4 と 1.7.1 でバイト単位同一）。**0.18 → 0.38809**、**最大傾き 2.632 @ x≈0.108**、x=0 で傾き 0.799、x=1 で 0.133。
- ★ **`RefBaselineRGBTone`**: **色相保存 RGB カーブ**。max と min にのみカーブを適用し `mid' = min' + (max'−min')·(mid−min)/(max−min)`。HSL/HSV 色相と (mid−min)/(max−min) が厳密に不変。**per-channel にすると DNG 準拠の全レンダラと目に見えて色がずれる。**

### 公開 API に Highlights は存在しない

`dng_render` の公開 API は `SetWhiteXY / SetExposure / SetShadows / SetToneCurve / SetFinalSpace / SetFinalPixelType / SetMaximumSize / Render` のみ。**Highlights コントロールなし。**`fShadows` は既定 **5.0** の**黒クリップ率**（`black = Shadows × ShadowScale × Stage3Gain × 0.001`）で、DNG タグ `ShadowScale` (50739) の記述 "used by **older versions of Adobe Camera Raw** to control the sensitivity of its **'Blacks' slider**" と合わせると、**旧 ACR (PV2003/2010) の Blacks スライダーの再実装**【強い推論】。PV2012 の Shadows とは無関係。

### DNG 仕様はレンダリングを規定していない

処理モデルは Ch.5「linear reference values への写像」と Ch.6「CIE XYZ への写像」で終わる。"tone curve" は全 126 ページ中 4 ページ（すべてタグ定義）のみ。**規範的デフォルトトーンカーブも規範的レンダリングも仕様に存在しない。** ACR3 デフォルトカーブは **SDK だけ**の産物。

- **ProfileToneCurve (50940)**: "a default tone curve that can be applied while processing the image **as a starting point for user adjustments** … in linear gamma … DNG readers should interpolate the curve using a **cubic spline**."
- **BaselineExposure (50730)**: "specifies by how much (in EV units) to move the zero point [of exposure compensation]."
- **DefaultBlackRender (51110)**: "The amount and method of black subtraction **may be automatically determined and may be image-dependent.**" ← 仕様自身が「真の黒点ロジックはコンバータ固有・画像依存」と認めている

第三者裏付け: RawTherapee `rtengine/dcp.cc` の `adobe_camera_raw_default_curve[]` は dng_sdk の `kTable` と 1025 float バイト単位同一。Anders Torger (DCamProf, [torger.se/anders/dcamprof.html](https://torger.se/anders/dcamprof.html)): "**it's not specified in the DNG specification how the tone curve should work**" / "camera profiles are limited by that **they can only apply a global adjustment, and thus not make any local adjustments adapted specifically for the image content.**"

**→ DNG SDK からアルゴリズムは何も引き出せない。ただし `RefBaselineRGBTone` の色相保存方式は必ず踏襲すべき。**

---

# 3. オープンソース比較対象

> ⚠️ **ライセンスの罠（2 重に注意）**
> 1. darktable / RawTherapee / ART / GEGL / Filmulator / PhotoFlow はすべて **GPL-3.0**、RapidRAW は **AGPL-3.0**。MIT の Silverbox にコードをコピーできません。
> 2. **リポジトリの LICENSE だけを見てはいけない。ファイルヘッダを個別に確認すること。** 実例: RawTherapee の `EdgePreservingDecomposition.{h,cpp}` はリポジトリが GPL-3.0 にもかかわらず、ファイル内に独自の非 OSI ライセンスを持ちます — *"It's free. **You may not incorporate this code as part of proprietary or commercial software**, but via freeware you may use its output for profit. You may modify and redistribute, but keep this big comment block intact."* 同様に vkdt は BSD-2 ですが GPL のポケットがあります（§3.5）。

## 3.0 前提の訂正

| 当初の想定 | 実際 |
|---|---|
| darktable shadhi は GIMP プラグイン由来 | **逆。** GEGL の `shadows-highlights.c` ヘッダ: *"This operation is a **port of the Darktable Shadows Highlights filter**, copyright (c) 2012--2015 Ulrich Pegelow. GEGL port: Thomas Manni."* — [gegl source](https://gitlab.gnome.org/GNOME/gegl/-/raw/master/operations/common-gpl3%2B/shadows-highlights.c) / [GIMP 2.10 docs](https://docs.gimp.org/2.10/en/gimp-filter-shadows-highlights.html): *"The implementation closely follow its counterpart in the Darktable photography software."* |
| RT の DRC は Mantiuk か Fattal 系 | **Fattal 2002 で確定。Mantiuk は否定。** |
| RT の旧 "Tone Mapping" は Mantiuk か Fattal 2008 EPD | **どちらでもない。Farbman/Fattal/Lischinski/Szeliski 2008 の WLS。** |
| RT の S/H 改修は 5.5〜5.8 頃 | **RT 5.5、2 段階**（2018-04 新ツール、2018-10 guided filter 化）。 |

## 3.1 darktable `shadows and highlights` — 反面教師

**GPL-3.0.** [manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/shadows-and-highlights/) · [source `src/iop/shadhi.c`](https://github.com/darktable-org/darktable/blob/master/src/iop/shadhi.c)（705 行）

**系譜【確定事実】**: 初回コミット `42b05bf43`, 2012-02-15, Ulrich Pegelow。[darktable.org/2012/02/shadow-recovery-revisited](https://www.darktable.org/2012/02/shadow-recovery-revisited/) で発表され、[lowpass filter レシピ](https://www.darktable.org/2012/02/using-lowpass-filter-to-recover-shadows/)（radius 50 の lowpass blur + contrast −1 で反転 + saturation 0 で脱色 → **overlay** ブレンド ~90%）をモジュール化したもの。

**アルゴリズム【確定事実、`process()` より】** — Lab 空間（`IOP_CS_LAB`）、正規化 `L/100, a/128, b/128`:

1. Lab 画像全体を **gaussian**（`dt_gaussian_blur_4c`, σ = radius·scale）**または bilateral**（`dt_bilateral_*`, `sigma_r = 100.0` 固定, `sigma_s = σ`, `detail = -1`）でぼかす
2. ぼかした画素を**反転・脱色**: `out.L = 100 − out.L; out.a = out.b = 0`
3. 両者を `whitepoint = max(1 − wp/100, 0.01)` で除算
4. **overlay ブレンドを `floor(|s|²)` 回＋端数 1 回**（`shadows`/`highlights` は `2·(p/100)` にプリスケールされるので `s² ∈ [0,4]` = **最大 4 回**）:
   ```c
   ta[0] = la*(1 - optrans)
         + (la > 0.5f ? 1 - (1 - 2*(la-0.5f))*(1-lb) : 2*la*lb) * optrans;
   ```
5. **`compress` はマスクへの階調ゲート**（半径ではない）:
   ```c
   highlights_xform = CLAMP(1 - tb[0]/(1-compress), 0, 1);
   shadows_xform    = CLAMP(tb[0]/(1-compress) - compress/(1-compress), 0, 1);
   optrans          = chunk * (highlights|shadows)_xform;
   ```
   `compress` は ≤0.99 にクランプ。100% で no-op。
6. 彩度は `lref = 1/|la|`, `href = 1/|1−la|` から作った `chroma_factor` を `shadows_ccorrect`/`highlights_ccorrect` で混合 → **これが記録されている色相ドリフトの原因**
7. `UNBOUND_*` フラグで L/a/b を段階ごとに色域外に出せる（gaussian は既定で unbound、bilateral は bound）

**パラメータ【確定事実】**

| Param | UI | Min | Max | Default |
|---|---|---|---|---|
| `shadows` | shadows | −100 | 100 | **50** |
| `highlights` | highlights | −100 | 100 | **−50** |
| `whitepoint` | white point adjustment | −10 | 10 | 0 |
| `radius` | radius | 0.1 | 500 | **100** |
| `compress` | compress | 0 | 100 | **50** |
| `shadows_ccorrect` | shadows color adjustment | 0 | 100 | **100** |
| `highlights_ccorrect` | highlights color adjustment | 0 | 100 | **50** |
| `shadhi_algo` | soften with | gaussian / bilateral | — | **bilateral filter** |

**halo 問題【確定事実】**
- 公式マニュアル: *"This module performs blurs in Lab color space, which can result in a number of issues when the parameters are pushed hard, **including halos, high local contrast in highlights, and hue shifts towards blue in the shadows**. You are advised to use the **tone equalizer** module instead."*
- Aurélien Pierre, [PIXLS.US, 2020-01](https://pixls.us/articles/darktable-3-rgb-or-lab-which-modules-help/): S&H は *"gives halos quickly as soon as you push the parameters… does not work, except for minor corrections. **Prefer the tone equalizer.**"*

> **→ この構造は模倣してはいけません。** 病理は構造的です: 知覚空間で、ガイドなしの単一ぼかしをオーバーレイマスクとして使い、最大 4 回反復する。

## 3.2 darktable `tone equalizer` — マスク方式の最高峰

**GPL-3.0.** [manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/tone-equalizer/) · [source `src/iop/toneequal.c`](https://github.com/darktable-org/darktable/blob/master/src/iop/toneequal.c)（3277 行）· [PR #1904](https://github.com/darktable-org/darktable/pull/1904) · [設計スレッド](https://discuss.pixls.us/t/a-tone-equalizer-in-darktable/10678) · [darktable 3.0 リリース](https://www.darktable.org/2019/12/darktable-30/)

`linear, RGB, scene-referred`。3 段構成【確定事実、ファイル内 `DOCUMENTATION` ブロックより】:

> *"The exposure correction is computed as a series of each octave's gain weighted by the gaussian of the radial distance between the current pixel exposure and each octave's center… The actual factors of the gaussian series are computed by **solving the linear system** taking the user-input parameters as target exposures compensations."*
> *"The details preservation modes make use of a fast guided filter optimized to perform an edge-aware surface blur on the luminance mask, in the same spirit as the bilateral filter, **but without its classic issues of gradient reversal around sharp edges**."*

**ゾーン構成【確定事実】**
- **ユーザ 9 スライダー**（`CHANNELS = 9`）: `centers_params[] = {-8,-7,-6,-5,-4,-3,-2,-1,0}` EV（blacks / deep shadows / shadows / light shadows / mid-tones / dark highlights / highlights / whites / speculars）。各 ±2 EV、既定 0。
- **内部 8 オクターブ**（`PIXEL_CHAN = 8`）: `centers_ops[] = {-8, -48/7, -40/7, -32/7, -24/7, -16/7, -8/7, 0}`（8 EV を 7 等分）。
- 9 目標 → 8 基底で優決定系なので **`pseudo_solve()`（Cholesky 最小二乗、`src/iop/choleski.h`）**。不安定なら GUI が *"the interpolation is unstable, decrease the curve smoothing"* と警告。

**補正の適用【確定事実】**
```c
exposure   = clamp(log2f(luminance[k]), -8.0f, 0.0f);
correction = Σ_i exp(-(exposure - centers_ops[i])² / gauss_denom) * factors[i];
correction = clamp(correction, 0.25f, 4.0f);   // ±2 EV
out[c]     = correction * in[c];               // スカラー × RGB ベクトル、linear
```
8×10000 エントリの LUT に事前計算。**1 画素につき 1 つのスカラーゲインを RGB 三つ組全体に掛ける**ので、色相・彩度は構造的に不変。

**マスキングタブのパラメータ【確定事実】**

| Param | UI | Min | Max | Default |
|---|---|---|---|---|
| `method` | luminance estimator | — | — | **RGB euclidean norm** (`NORM_2`) |
| `details` | preserve details | — | — | **EIGF** |
| `blending` | smoothing diameter | 0.01 | 100 (%) | **5** |
| `feathering` | edges refinement/feathering | 0.01 | 10000 | **1.0**（ソフトレンジ 0.1–50） |
| `iterations` | filter diffusion | 1 | 20 | **1** |
| `quantization` | mask quantization | 0 | 2 | 0 |
| `exposure_boost` | mask exposure compensation | −16 | 16 EV | 0 |
| `contrast_boost` | mask contrast compensation | −16 | 16 EV | 0 |
| `smoothing` | curve smoothing（advanced タブ） | — | — | √2 |

輝度推定子（`src/common/luminance_mask.h`）: RGB average / HSL lightness / HSV value / RGB sum / **RGB euclidean norm** / RGB power norm / RGB geometric mean。

**★ 3 つのマスクノブの正確な意味【確定事実、`commit_params` / `modify_roi_in` より】**
```c
d->blending       = p->blending / 100.0f;      // 画像長辺に対する割合
d->feathering     = 1.0f / p->feathering;      // ★ 反転
d->contrast_boost = exp2f(p->contrast_boost);
d->exposure_boost = exp2f(p->exposure_boost);

max_size = max(iwidth, iheight);
diameter = d->blending * max_size * roi_in->scale;
radius   = (int)((diameter - 1.0f) / 2.0f);
```
- ★ **"smoothing diameter" = guided filter の窓直径を「画像長辺の %」で指定 → 解像度非依存。** 既定 5%。マニュアル推奨: **EIGF なら 1–10%、素の GF なら 1–25%**。
- ★ **"edges refinement/feathering" は guided filter の `1/ε`。UI 値が大きい ⇒ ε が小さい ⇒ エッジ追従が強い。**（マニュアルの「高い値ほどエッジに追従」が正しいのはこの反転のため）
- **"mask quantization"** は log2 空間でガイドをポスタライズ: `out[k] = clamp(exp2f(floorf(log2f(image[k])/sampling) * sampling), min, max)`
- **"filter diffusion"** は反復回数。カーネルが毎回 √2 倍に成長。

**★ Guided filter vs EIGF — 概念として最も盗む価値がある部分【確定事実】**

標準 He et al.（`src/common/fast_guided_filter.h`、ヘッダが [arXiv:1505.00996](https://arxiv.org/abs/1505.00996) を引用）:
```c
d = max((E[I²] - E[I]²) + feathering, 1e-15);   // var + ε
a = (E[Ip] - E[I]E[p]) / d;                     // cov / (var + ε)
b = E[p] - a * E[I];
```
フィルタ前に 4× ダウンスケール、後でアップスケール（*"a free 10× speed-up… ×50 to ×200 vs `guided_filter.h`"*）。`DT_GF_BLENDING_GEOMEAN`（フィルタ済みと元画像の幾何平均）も提供。

**EIGF**（`src/common/eigf.h`、**rawfiner** 作、コミット `c167f9d8f` 2020-10-03、[PR #6444](https://github.com/darktable-org/darktable/pull/6444) 2020-10-22 マージ、[darktable 3.4](https://www.darktable.org/2020/12/darktable-3-4/) で出荷）。ヘッダの逐語:

> *"As variance depends on the exposure, the original guided filter preserves much better the edges in the highlights than in the shadows. In particular doing: (1) increase exposure by 1EV (2) guided filtering (3) decrease exposure by 1EV **is NOT equivalent** to doing the guided filtering only.*
> *To overcome this, instead of using variance directly to determine "a", we use a ratio: **variance / (pixel_value)²**. We tried also… variance/average² and variance/(pixel_value·average); we kept variance/(pixel_value)² as it seemed to behave a bit better…*
> *However, due to the fact that the average advantages the bright pixels… we get **strong bright halos**. These are due to the spatial averaging of "a" and "b" performed at the end of the filter, especially of "b". **We decided to remove this final spatial averaging**, as it is very hard to keep it without having either large unsmoothed regions or halos."*

実装（`eigf_blending`）:
```c
norm_g         = max(avg_g * image[k], 1e-6);
norm_m         = max(avg_m * mask[k],  1e-6);
norm_var_guide = var_g / norm_g;
norm_covar     = covar_mg / sqrtf(norm_g * norm_m);
a = norm_covar / (norm_var_guide + feathering);
b = avg_m - a * avg_g;
image[k] = max(image[k]*a + b, MIN_FLOAT);   // ★ a,b の最終ボックス平均を行わない
```
He et al. からのさらなる逸脱: **box blur ではなく gaussian blur**（*"We also use gaussian blurs instead of the square blurs of the guided filter"*）、ダウンスケール率が適応的 `scaling = clamp(sigma, 1, 4)`。[darktable 3.4 アナウンス](https://www.darktable.org/2020/12/darktable-3-4/)は第 2 の動機も挙げる: 旧 GF は *"more sensitive to vertical/horizontal edges than to diagonal ones"*。PR #6444 は約 **4.7× の高速化**（1.8 s → 0.38 s）も報告。

5 モード出荷: `no` / `guided filter` / `averaged guided filter` / **`EIGF`（既定）** / `averaged EIGF`。"averaged" は未フィルタ画像との幾何平均。

**★ 出荷プリセット【確定事実、`init_presets()`】— 校正の参照点として有用**

`compress shadows/highlights` の soft/medium/strong × GF/EIGF。共通形状は −4 EV 中心、`exposure_boost = −1.57` EV（中間グレーをレンジ中央へ）:
```
blacks = +s      deep shadows = +5/3 s   shadows = +5/3 s   light shadows = +s
mid-tones = 0    dark highlights = −s    highlights = −5/3 s
whites = −5/3 s  speculars = −s
s = 0.25 / 0.45 / 0.65 EV（soft/medium/strong）
```

| Preset | details | blending | feathering | iterations |
|---|---|---|---|---|
| soft EIGF | EIGF | 5 % | 1 | 1 |
| soft GF | GF | 5 % | **500** | 1 |
| medium EIGF | EIGF | 3 % | 7 | 3 |
| medium GF | GF | 3 % | **500** | 3 |
| strong EIGF | EIGF | 2 % | 20 | 5 |
| strong GF | GF | 2 % | **500** | 5 |

★ 顕著な非対称: **GF プリセットは全て feathering = 500（ε = 0.002）固定、EIGF は 1〜20。** マニュアルのトレードオフ説明: *"The variants using the guided filter tend to **preserve local contrast in the shadows better**… but at the price of **reducing the local contrast in the highlights**."*

**Aurélien の記述【確定事実】**
- PR #1904: *"very similar to Lightroom, with blacks/shadows/midtones/highlights/whites cursors"*; *"Each band-pass filter is defined by a gaussian window so that for every pixel, the sum of the weights of all windows are constant (= 1.77)"*; *"This approach shows none of the interpolation artifacts (cusps) of the splines interpolation."*
- [設計スレッド](https://discuss.pixls.us/t/a-tone-equalizer-in-darktable/10678): *"scene-referred RGB because I have had enough of the crazy tonemapping Lab nonsense in my life"*
- ポータル: [aurelienpierre.com/en/](https://aurelienpierre.com/en/) · [eng.aurelienpierre.com](https://eng.aurelienpierre.com/)

**⚠ tone equalizer にも EIGF にも論文・プレプリントは存在しません。** 設計文書はソース内の `DOCUMENTATION` ブロック、PR #1904、PR #6444、pixls.us スレッドのみ。彼の唯一の長文技術記事 [*Filmic, darktable and the quest of the HDR tone mapping*](https://eng.aurelienpierre.com/2018/11/filmic-darktable-and-the-quest-of-the-hdr-tone-mapping/) はグローバル filmic カーブの話で局所適応ではありません。

## 3.3 darktable `local contrast`（local laplacian モード）— LR に最も近い GPL 実装

**GPL-3.0.** [manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/local-contrast/) · UI `src/iop/bilat.c` · カーネル `src/common/locallaplacian.c` (+`locallaplaciancl.c` OpenCL)

モジュール名 `local contrast`、エイリアス **`clarity`**。`non-linear, Lab, display-referred` の **L チャンネルのみ**。`s_mode_local_laplacian` が既定。

| Param | UI (LL モード) | UI (bilateral モード) | 構造体 Min/Max | Default |
|---|---|---|---|---|
| `detail` | detail | detail | −1.0 / 4.0 | 0.25 |
| `sigma_r` | **highlights** | contrast（range σ） | 0 / 100（LL モードでは実効 ~2.0） | 0.5 (LL) / 20 (bilateral) |
| `sigma_s` | **shadows** | coarseness（spatial σ） | 0 / 100（同上） | 0.5 (LL) / 50 (bilateral) |
| `midtone` | midtone range | — | 0.001 / 1.0 | 0.5 |

★ 設計上の注目点: **同じ 2 つの float が LL モードでは `highlights`/`shadows`、bilateral モードでは range/spatial σ として再利用されている。**

呼び出し: `local_laplacian(in, out, w, h, /*sigma=*/midtone, /*shadows=*/sigma_s, /*highlights=*/sigma_r, /*clarity=*/detail)`

**リマッピングカーブ【確定事実、`curve_scalar()`】**（`c = x − g`、`sigma` = midtone range）:
```c
if      (c >  2*sigma) val = g + sigma + shadows    * (c - sigma);   // 直線
else if (c < -2*sigma) val = g - sigma + highlights * (c + sigma);   // 直線
else                   /* 二次ベジエで直線同士を接続 */;
val += clarity * c * exp(-c*c / (2*sigma*sigma/3));                  // 微分ガウシアン
```
**`num_gamma = 6`** 離散レベル（`gamma[k] = (k+0.5)/6`）、collapse 時に線形補間。`max_levels = 30`、実際は `MIN(30, 31-clz(MIN(w,h)))` で**フルピラミッド**。

**★ Johannes Hanika の実装知見【確定事実】** — [darktable.org/2017/11/local-laplacian-pyramids](https://www.darktable.org/2017/11/local-laplacian-pyramids/) / [draft](https://jo.dreggn.org/blog/laplacian/post.html)

> *"process the image n times, mapping it through a curve, create the n laplacian pyramids, merge into a final laplacian pyramid, collapse this output pyramid"*
>
> *"the contrast-s curve in the center part is modelled by a **derivative of gaussian** (with infinite support), which is added to the straight lines on either side, which are blended over using a quadratic bezier curve. … **[the reference paper's curves] will produce random aliasing when used with the fast local laplacian code.**"*
>
> ★ *"**for the shadow/highlight use case, the pyramid needs to be constructed all the way all the time, we can't stop after three levels (or else the shadow lifting would depend on the scale of the image).**"*
>
> *"**the gpu is really good at processing laplacian pyramids. the opencl port of this turned out to be very useful.**"*
>
> *"the filter accentuates noise … **enable chroma denoising** as preprocessing"*

マニュアルの警告: *"This setting **can cause banding artifacts** in the image if pushed to extreme values. This is due to the way in which darktable computes the **fast approximation** of the local laplacian filter."* → **num_gamma = 6 は少なすぎる可能性。Silverbox は 8〜16 を検討すべき。**

マニュアルの shadows 説明: *"**a lower value lifts the shadows and can effectively simulate a fill light.** Note that this is done with local manipulation of the image. However, this means that **a completely dark image cannot be brightened in this way — only dark objects in front of bright objects are affected.**"* ← LLF 型オペレータの本質的な限界。E1 実験の予測と直結。

## 3.4 その他の darktable モジュール【確定事実】
- `filmicrgb.c` — **グローバル**。トーン経路に空間フィルタなし。`reconstruct_*` はウェーブレットによる**クリップチャンネル修復**であり局所トーン適応ではない。
- `tonemap.cc` — **非推奨**。ヘッダ: *"A tonemapping module using **Durand's process** — http://graphics.lcs.mit.edu/~fredo/PUBLI/Siggraph2002/. Use andrew adams et al.'s permutohedral lattice, for fast bilateral filtering."* 真に局所的だが放棄済み。
- `globaltonemap.c` — **非推奨**、グローバルのみ（Reinhard / Filmic / Drago）。
- `zonesystem.c` — tone equalizer に置換。

## 3.5 ★★★ vkdt `llap` — BSD-2-Clause の GLSL 実装（最重要の再利用可能資産）

- リポジトリ: [hanatos/vkdt](https://github.com/hanatos/vkdt)（darktable の LLF を書いた Johannes Hanika 本人）
- ライセンス: [LICENCE.bsd2](https://github.com/hanatos/vkdt/blob/master/LICENCE.bsd2) — **BSD-2-Clause**
- モジュール: [`src/pipe/modules/llap/`](https://github.com/hanatos/vkdt/tree/master/src/pipe/modules/llap)

**readme の逐語【確定事実】** — タイトルは *"llap: local contrast, shadows, and highlights"*:

> *"this employs **local laplacian pyramids**, with a few extra tweaks for improved quality, and in a **glsl implementation for speed**. it works on the **luminance channel only (Y channel of XYZ)**, and reconstructs colours later by applying the method of **Mantiuk 2009**."*
>
> *"decreasing `sigma` will… instead consider a larger range of pixels as *shadows* or *highlights*, giving more power to the corresponding sliders."*

**パラメータ範囲**: `shadows` 0–10 / `hilights` 0–10 / `clarity` −1–3

**なぜ重要か**: **GPU シェーダで書かれた「PV2012 型の局所 Laplacian shadows/highlights」の、唯一 permissive にライセンスされた前例。** WGSL への移植は構造的に素直です（輝度のみ処理 → 色は後段で復元）。

⚠️ **必須のデューデリジェンス**: readme は *"BSD-2 **if not clearly marked otherwise in the respective source files, which contain a bit of viral GPLv3**, so handle with care"* と警告しており、リポジトリには `LICENCE.gpl3` も同梱されています。スポットチェックでは `llap/` 配下に GPL ヘッダは見当たらず（GPL は `src/qvk/*`, `i-mlv/`, `i-raw/exif.h`, `rt/quat.h` にある）が、**読み込む前にファイル単位で再確認すること。可能な限りコードより論文を仕様として使うこと。**

## 3.6 RawTherapee

**GPL-3.0**（[repo](https://github.com/Beep6581/RawTherapee)、全 rtengine ヘッダが GPLv3 通知を保持）

### 3.6.1 `Shadows/Highlights` — guided filter 方式のクリーンな見本

[RawPedia](https://rawpedia.rawtherapee.com/Shadows/Highlights) · [source `rtengine/ipshadowshighlights.cc`](https://github.com/Beep6581/RawTherapee/blob/dev/rtengine/ipshadowshighlights.cc)（Alberto Griggio, 2018）

**改修の正確な日付【確定事実、git history】**

| Commit | 日付 | 作者 | 内容 |
|---|---|---|---|
| `25b066e25` | 2018-04-13 | Griggio | *"first version of new shadows/highlights tool"* |
| `6bea42283` | 2018-04-24 | Griggio | *"add a bit more contrast in the shadows"* |
| `c45ec6f16` | 2018-04-26 | heckflosse | 高速化＋バグ修正 |
| **`17e4f6f25`** | **2018-10-03** | **Griggio** | ***"enhanced shadows/highlights to avoid halos and desaturation — use a guided filter instead of Gaussian blur for computing the masks — operate in [RGB]"*** |
| `30d8a674a` | 2018-10-03 | Griggio | *"added colorspace selection (RGB or L\*a\*b\*)"* |

**RT 5.5** で出荷。コミュニティ検証: [Test the new and enhanced Shadows/Highlights tool](https://discuss.pixls.us/t/test-the-new-and-enhanced-shadows-highlights-tool/9329)（*"much smoother transition, less haloing"*、ただし従来と同等のシャドウ持ち上げには radius を増やす必要があり *"at the expense of some loss of detail"*）。

**旧アルゴリズム（≤ RT 5.4）【確定事実】**: クラス `SHMap`（`rtengine/shmap.cc/.h`, Gabor Horvath, 2004–2010）がぼかし輝度マップを作り、**マップの統計から閾値を導出**していた:
```c
h_th = shmap->max_f - params->sh.htonalwidth * (shmap->max_f - shmap->avg) / 100;
s_th =               params->sh.stonalwidth * (shmap->avg - shmap->min_f) / 100;
```
`SHMap::update()` は 2 経路: `!hq` → 反復ボックスブラー/`gaussianBlur`、`hq` → *"experimental dirpyr shmap"*（方向性ピラミッド、bilateral 的、`rangefn` LUT）。
→ **旧 = 画像統計にアンカーした閾値 + gaussian（or dirpyr）マップ / 新 = 固定閾値 + guided filter。** `shmap.cc` は `dev` に残るが S/H からは未使用。

**現行アルゴリズム【確定事実、ソースより】** — highlights → shadows の順に、同じラムダを 2 回。**隠れゲイン係数に注意**:
```cpp
if (hightli > 0) apply(hightli * 0.7, hltonal, true);
if (shado   > 0) apply(shado   * 0.6, shtonal, false);
```
各パス:
1. **マスク構築**（`thresh = tonalwidth * 327.68f`、窓外は 4 次減衰）:
   ```cpp
   // highlights                                  // shadows
   mask = (l > thresh) ? 1 : pow4(l * scale);      mask = (l <= thresh) ? 1 : pow4(scale / l);
   L    = 1 - l/32768;                             L    = l/32768;
   ```
2. **エッジ認識リファインメント — L をガイドにマスクを guided filter**:
   ```cpp
   guidedFilter(L, mask, mask, radius, 0.075, multiThread, 4);
   // radius = rad * 10 / scale ;  epsilon = 0.075 ;  subsampling = 4
   ```
3. **1-D ガンマ LUT**（トーン移動自体は純粋な冪関数）:
   ```cpp
   base  = pow(4.f, amount/100.f);
   gamma = hl ? base : 1.f / base;      // amount ∈ [0,100] → gamma ∈ [1,4] or [1/4,1]
   ```
   shadows のみ NURBS コントラストカーブを追加合成（*"get a bit more contrast in the shadows"*）: (0,0), (0.25,0.25), (1,1) に固定、0.125/0.375 のノットを `contrast = pow(2, amount/100)` で押す。
4. **マスクでブレンド**: `lab->L = intp(blend, f[l], l)`, `blend = LIM01(mask)`。Lab モードでシャドウ持ち上げ時は彩度もスケール: `s = max(newL/l * 0.5, 1) * blend`。RGB モード（既定）では Lab 経由で LUT を作りチャンネルごとに適用、`OOG(c)` で色域外ガード。

**パラメータ【確定事実、`SHParams`】**

| Field | UI | Default |
|---|---|---|
| `highlights` | Highlights | 0 |
| `htonalwidth` | Highlights tonal width | **70** |
| `shadows` | Shadows | 0 |
| `stonalwidth` | Shadows tonal width | **30** |
| `radius` | Radius | **40** |
| `lab` | use L\*a\*b\* | **false**（⇒ RGB） |

RawPedia: RT **5.5** が *"an edge-aware **fast guided filter**"* を導入し *"prevent halos"*、既定は *"in RGB space… to maintain saturation"*。極端なダイナミックレンジには **先に Dynamic Range Compression を使え**。

⚠️ **ε = 0.075 は、後述の定量比較論文が「GF の halo 最悪」と判定した設定そのものです。**

> **→ darktable の shadhi よりはるかにクリーンで、我々の目的に近いテンプレート**: *4 次階調窓マスク → guided filter リファインメント → 画素単位ガンマ LUT → マスクブレンド*。これは「**エッジ認識な空間マスクで変調された 1-D トーンカーブ**」であり、Lightroom の 2 つのありうる解釈のうちの一方です。

### 3.6.2 `Dynamic Range Compression` — Fattal 2002 確定

[RawPedia](https://rawpedia.rawtherapee.com/Dynamic_Range_Compression) — *"based on the **Gradient Domain High Dynamic Range Compression** algorithm developed by R. Fattal and coworkers… often simply referred to as 'Fattal', e.g. in Luminance HDR."*

ソース `rtengine/tmo_fattal02.cc` ヘッダ逐語:
> *"@file tmo_fattal02.cpp — @brief TMO: Gradient Domain High Dynamic Range Compression. Implementation of Gradient Domain High Dynamic Range Compression by **Raanan Fattal, Dani Lischinski, Michael Werman**. @author Grzegorz Krawczyk. This file is a part of **LuminanceHDR** package, based on pfstmo."*（Alberto Griggio が RT に移植）

**Mantiuk は明確に否定**（ソースにも RawPedia にも記述なし）。

| Field | UI | Default | RawPedia |
|---|---|---|---|
| `amount` | Amount | **20** | *"strength of the compression. Higher values lead to a narrower dynamic range."* |
| `threshold` | Detail | **30** | *"how much local contrast is preserved. Positive values reduce the compression in favor of more contrast, negative values reduce the contrast."* |
| `anchor` | Anchor | **50** | *"biases the compression towards the shadows or highlights, effectively functioning as an exposure compensation."* |

適用位置: **Noise Reduction と Haze Removal の直後、Exposure などのトーンカーブより前。**

⚠️ **RawPedia 自身の警告（実運用上の重要な教訓）**: *"**The effects of this tool depend on the dynamic range (and histogram) of the image being edited.** If you are processing a series of images intended for stitching… even if you were to apply identical parameters… there would be **sudden changes in brightness between adjacent images**. **Do not use this Dynamic Range Compression tool on the source images.**"*
→ **グローバルヒストグラム依存のオペレータが持つ弱点の実例。Silverbox が「自動レンジ伸縮」層（§2.1 機構 B）を実装するなら同じ罠があります。**

### 3.6.3 `Tone Mapping`（旧ツール）— Farbman 2008 WLS、Mantiuk でも Fattal でもない

[RawPedia](https://rawpedia.rawtherapee.com/Tone_Mapping) が *"Edge-Preserving Decompositions for Multi-Scale Tone and Detail Manipulation"*（= Farbman, Fattal, Lischinski, Szeliski, SIGGRAPH 2008 = WLS 論文）を引用。

ソース `rtengine/EdgePreservingDecomposition.cc/.h`（"ben_pcc" 作、2011-11 統合）ヘッダ逐語:
> *"this is an implementation of what's presented in the following papers: — Edge-Preserving Decompositions for Multi-Scale Tone and Detail Manipulation; — An Iterative Solution Method for Linear Systems of Which the Coefficient Matrix is a Symmetric M-Matrix; — Color correction for tone mapping."*
> 意図的な逸脱: *"Reformulated the minimization with **finite elements instead of finite differences**… A **single rotationally invariant edge stopping function** is used instead of two non-invariant ones… **Incomplete Cholesky factorization instead of Szeliski's LAHBF. Slower, but not subject to any patents.** For tone mapping, original images are decomposed instead of their logarithms, and just one decomposition is made."*

`SparseConjugateGradient` で解く。パラメータ（`EPDParams` 既定）: `strength` 0.5, `gamma` 1.0, `edgeStopping` 1.4, `scale` 1.0, `reweightingIterates` 0（GUI 表示値は再スケールされるのでソースを信用すること）。

⚠️ **§3 冒頭のライセンス罠。このファイルは GPL ではない独自の非商用ライセンス。いかなる形でも使用不可。**

### 3.6.4 その他 RT ツール【確定事実】
- **`Local Contrast`**（`rtengine/iplocalcontrast.cc`）— L へのアンシャープマスク。既定: `radius` 80, `amount` 0.20, `darkness` 1.0, `lightness` 1.0。
- **Wavelet Levels** — contrast-by-level、compression by level、attenuation response、directional contrast。
- **Local Adjustments (locallab)**（`rtengine/iplocallab.cc`）— **S/H スポットは同じ関数を呼ぶ**。`ipshadowshighlights.cc` に *"modifications to pass parameters needs by locallab, to avoid 2 functions - no change in process - J. Desmis march 2019"* とあり、シグネチャ `shadowsHighlights(lab, ena, labmode, hightli, shado, rad, scal, hltonal, shtonal)` を共有。**locallab の S/H = 同じ guided filter アルゴリズムをスポットにスコープしたもの。** [RawPedia Local Adjustments](https://rawpedia.rawtherapee.com/Local_Adjustments) は locallab の Tone Equalizer、Tone Mapping スポット、*"Laplacian PDE algorithms to take into account deltaE and minimize artifacts"* を使う "Dynamic Range & Exposure" スポット、ウェーブレット局所コントラストも列挙。
  ⚠️ **同ページの「locallab Tone Mapping は Mantiuk アルゴリズム」という記述はソース（EPD/Farbman）と矛盾。RawPedia のこのページのアルゴリズム帰属は信用しないこと。**

### 3.6.5 RT の LR 比較ドキュメント
**存在しない。** RawPedia の S/H・DRC ページは Lightroom にも Adobe にも一切言及していません。

## 3.7 その他のプロジェクト

- **ART (Another RawTherapee)**, Alberto Griggio — [repo](https://github.com/artraweditor/ART) · [docs](https://art.pixls.us/Reference)（ルート `art.pixls.us/` は 404）。**GPL-3.0-or-later**（ヘッダ確認済み: *"Copyright (C) 2004-2012 Gabor Horvath; 2010-2018 RawTherapee development team; 2018-2026 Alberto Griggio"*）。
  - **LR 的挙動のドキュメント化はしていない。** Reference Manual の Adobe 言及は 1 箇所のみで、カーブ形状の話（"Film-like" カーブは *"designed by Adobe as a part of DNG and is thus the one used by Adobe Camera Raw and Lightroom"*）。「Lightroom-inspired」は第三者レビューの表現であり ART の公式文書ではない。
  - ★ **構造的発見: ART は独立した Shadows/Highlights ツールを廃止**（`rtengine/` に `ipshadowshighlights.cc` が無い）。残っているのは `guidedfilter.cc`, `iplocalcontrast.cc`, `tmo_fattal02.cc`、そして **`iptoneequalizer.cc`**（ヘッダ: *"adapted from the tone equalizer of darktable, copyright (c) 2018 Aurelien Pierre"*）。**つまり GPL 圏は darktable の tone equalizer + Fattal DRC に収斂しています。**
- **Filmulator** — [repo](https://github.com/CarVac/filmulator-gui)、**GPL-3.0**。README: *"simulates the development of film… the **diffusion of 'developer' both between neighboring pixels and with the bulk developer in the tank**"* → *"Large bright regions become darker… Small bright regions make their surroundings darker, **enhancing local contrast**."* 真の局所トーンオペレータ（反応拡散 PDE）だが **Highlights/Shadows スライダーが無く、LR を名乗ってもいない。** 校正の参照にはならない。
- **RapidRAW** — [repo](https://github.com/CyberTimon/RapidRAW)（Rust + Tauri + wgpu、9.7k stars）、**AGPL-3.0**。WGSL シェーダは `blur / display / flare / shader` の 4 本のみ。**local Laplacian 実装なし。** [Issue #691](https://github.com/CyberTimon/RapidRAW/issues/691) で「Lightroom-style workflow」のパイプライン再設計が議論中。
- **PhotoFlow** — GPL-3.0。Carmelo_DrRaw が LLF を実験したが *"too slow to think about implementing it in PhF"* で断念（§2.5）。

### PV2012 を名乗るプロジェクト（GitHub コード検索）

`PV2012` のヒットの大半は XMP メタデータテーブル（ExifTool, MIDI2LR, RethinkRAW）。実際の試みは 2 件:

| Repo | ライセンス | 実態 |
|---|---|---|
| [markyip/RAWviewer `src/raw_pv2012.py`](https://github.com/markyip/RAWviewer/blob/main/src/raw_pv2012.py) | **MIT** | docstring は *"PV2012 (XMP ProcessVersion 11.0)"* トーンエンジンを名乗るが、⚠️ **局所適応ではない**。Highlights/Shadows は純粋な輝度領域ウェイト、guided filter は chroma denoise 専用。**反面教師として有用**（コメントに 8× のシャドウリフト上限で飽和、16× で青チャンネルのスペックルが出ると記録されている） |
| [janpipek/arraw ADR 0033](https://github.com/janpipek/arraw/blob/main/docs/adr/0033-perceptual-basic-tone-and-recoverable-headroom.md) | GPL-3.0 | 正直な免責: *"it is **not an attempt to clone Adobe's proprietary, image-adaptive Process Version 2012 algorithm**."* `smoothstep(0.35,0.65,x)` マスクを γ2.2 輝度に適用するグローバル閉形式 |

**→ PV2012 の再現を主張して成功しているプロジェクトは存在しません。**

## 3.8 ライセンス一覧

| プロジェクト / 資産 | ライセンス | コードとして使えるか |
|---|---|---|
| **Paris/Hasinoff MATLAB (LLF 2011)** | **MIT** | ✅ **そのまま移植可** |
| **Halide `apps/local_laplacian`** | **MIT** | ✅ **そのまま参照可**（`apps/bgu` のみ Apache-2.0） |
| **vkdt** | **BSD-2-Clause**（GPL ポケットあり） | ✅ **ファイル単位確認の上で可** |
| **google/bgu** | **Apache-2.0** | ✅（GLSL slice シェーダ同梱） |
| OpenCV / opencv_contrib ximgproc | Apache-2.0 / BSD-3 | ✅（LLF は含まれない） |
| **LLF 論文（Paris 2011 / Aubry 2014）** | 公開研究 | ✅ **論文から実装せよ** |
| Aubry MATLAB (Fast LLF 2014) | **ライセンスなし** | ❌ 読んで再実装のみ |
| He 本人の guided filter MATLAB | "academic only" | ❌ |
| darktable | GPL-3.0 | ❌ アイデアを読むのみ |
| RawTherapee | GPL-3.0（+ **EPD ファイルは独自の非商用ライセンス**） | ❌ |
| ART | GPL-3.0-or-later | ❌ |
| GEGL / GIMP | GPL-3.0 | ❌ |
| Filmulator / PhotoFlow | GPL-3.0 | ❌ |
| RapidRAW | AGPL-3.0 | ❌ |
| Adobe DNG SDK | "Proprietary Free"（OSI 非承認） | ❌ MIT リポジトリへの vendoring 不可（そもそも関連コードが無い） |
| Bart Wronski [local tonemapping JS demo](https://bartwronski.github.io/local_tonemapping_js_demo/) | **LICENSE ファイル無し**（ブログ本文に "public domain" のみ） | ⚠️ 本人確認が必要 |

---

# 4. WebGPU 実装性の評価

## 4.1 定量的なアーティファクト比較【確定事実】— 「GF は halo を出すが LLF は出さない」の一次資料

**[arXiv:1808.09411](https://arxiv.org/abs/1808.09411) "Quantitative Evaluation of Base and Detail Decomposition Filters Based on their Artifacts"**

7 手法（Bilateral / **Guided Filter** / WLS / **Fast Local Laplacian** / TV-L1 / IS-L0 / Domain Transform）を 4 種のアーティファクト（luminance halo / staircase / compartmentalization / contrast halo）で評価:

- **1 位: Fast Local Laplacian — "Only LLF succeeded passing the five artifact tests"**
- 2〜4 位: Fast Bilateral, TV-L1, WLS（各 1 つの問題）
- **最下位: Domain Transform, IS-L0, Guided Filter**（各々複数の critical な問題）
- 逐語: **"The worst filter for the luminance halo artifact is the guided filter."** / **"GF was actually introducing a new artifact, the contrast halo"**（7 手法中 GF だけ）
- 使用設定: **GF `r=40, ε=0.075²`** / FLL `l_max=6, σr=0.103` ← **GF の設定は RawTherapee の実装値とほぼ同一**

## 4.2 手法別のコスト／適性

| 手法 | 計算量 | 2–6MP WebGPU | halo | 参照実装ライセンス |
|---|---|---|---|---|
| **Guided Filter**（He 2010/2013, [TPAMI](https://kaiminghe.github.io/eccv10/)） | O(N)、半径非依存 | ◎ 極めて安い | **△ 大 r + 大 ε で最悪** | ximgproc Apache-2.0/BSD-3、tody411 MIT。⚠ He 本人の MATLAB は academic only |
| **Fast Guided Filter**（[arXiv:1505.00996](https://arxiv.org/abs/1505.00996)） | O(N/s²)、s=4 で >10× | ◎ | 同上 | 同上 |
| **Bilateral Grid**（Chen/Paris/Durand 2007） | splat + blur + slice | ◎ sub-ms〜数 ms（6MP で grid ≈ 6MB） | △ gradient reversal | Halide `apps/bilateral_grid` **MIT** |
| **BGU**（Chen et al. 2016） | 低解像度で係数を解き full-res で slice | ◎ | — | [google/bgu](https://github.com/google/bgu) **Apache-2.0**（GLSL slice 同梱） |
| **Fast Local Laplacian** | O(N) × 離散化数 | ○ 実用圏 | **◎ 唯一の全試験通過** | Halide `apps/local_laplacian` **MIT**、vkdt `llap` **BSD-2** |
| **Edge-Avoiding Wavelets**（Fattal 2009） | O(N) | ◎ | ○（軸整列リンギング） | permissive 実装なし |
| **WLS**（Farbman 2008） | 疎線形ソルバ | **✕** | ○ | RT の実装は使用不可 |
| **Domain Transform**（Gastal 2011） | O(N) 分離型 | ○（RF は走査線逐次、転置必要） | **✕ 下位グループ** | ximgproc BSD-3 |
| **Unnormalized Bilateral**（Aubry 2014 §2.2） | bilateral と同等 | ◎ | ○（bilateral より明確に良い） | 論文から実装 |

**WLS が web/GPU に不向きな理由**: (a) WGSL に疎行列直接解法がなく移植対象が無い、(b) multigrid の粗レベルは仕事量が少なく GPU を遊ばせる、(c) **反復回数が画像内容依存 → フレーム時間が非決定的**（スライダー操作に致命的）、(d) 当時の報告で約 **3.5 秒/MP**。

## 4.3 WebGPU 固有の実務ノート

- **fp32 SAT はフル解像度では破綻する。** GPU Gems 3 Ch.8: *"Summed-area tables burn precision fairly quickly: **log(width × height) bits**"*。24MP で log2(W·H) ≈ 24.5 bit → fp32 の 24bit 仮数を使い切る。
  → **タイル分割 prefix sum**（累積長を 256 に制限 = 8bit 消費）か、**そもそも Fast Guided Filter で box filter を低解像度側に寄せる**。
- **ストレージテクスチャ**: コア WebGPU の read-write storage は `r32uint / r32sint / r32float` のみ → **ping-pong 設計必須**。`rgba16float` は既定でフィルタ可能だが **`r32float` / `rgba32float` はサンプル不可**（`float32-filterable` 拡張が必要）。→ **`rgba16float` がピラミッド格納のスイートスポット。**
- **fp16 と Laplacian 係数**: 「近接ガウシアンレベルの差」なので catastrophic cancellation が起きる。**リニアな scene-referred 空間で fp16 ピラミッドを作ってはいけない**（base = 8.0 で量子化幅 ≈ 0.004）。
  → **log2 輝度など知覚的に平坦な空間でピラミッドを構築**し、差分計算は f32、残差格納は `rgba16float`（0 近傍の相対精度が高いので有利）。
- **Gaussian ピラミッド ≠ mip chain**: Burt–Adelson の `[1 4 6 4 1]/16`（Halide/vkdt は `[1 3 3 1]`）は 2×2 box ではない。**`collapse(build(x)) ≈ x` を 1e-3 以内で検証するユニットテストを必ず置くこと。**
- **フル解像度の上限**: `maxTextureDimension2D` 既定 **8192**（60MP 機の長辺 9504 は超える）、`maxStorageBufferBindingSize` 既定 **128 MiB**（60MP × 4ch × f32 = 960MB）。→ **タイル化必須、または低解像度処理 + slicing。**
- ★ **プレビュー忠実性**: Paris 本人の hindsight — *"The fact that our filters produce faithful low-resolution previews is related to our work on display-aware image editing"*（[ICCP'11](https://jankautz.com/publications/DisplayAwareICCP11.pdf)）。**LLF は低解像度プレビューが full-res を忠実に近似する性質を持つ**。Silverbox のプレビュー/エクスポート一貫性にとって大きな利点。
- **FPGA 論文**（[arXiv:2402.12407](https://arxiv.org/abs/2402.12407)）: Virtex-7 で最適化 CPU 比 7.5×。GPU 比較は無いが、"parallelization schemes using multi-core CPUs and GPUs have been proposed" と LLF の GPU 実装可能性自体は前提とされている。

## 4.4 推奨アーキテクチャ

1. **Fast Local Laplacian（輝度離散化版）を log2 輝度上で実装。** 参照は **Paris/Hasinoff MATLAB（MIT）** + **Halide `apps/local_laplacian`（MIT）** + **vkdt `llap`（BSD-2、要ファイル確認）**。
2. **remap カーブは必ず帯域制限する。** 区分線形の折れは Fast 版でエイリアシングを起こす（hanika の一次証言）。darktable と同様、中央部を**微分ガウシアン**、両端を直線、接続を二次ベジエで。
3. **輝度離散化数は 8〜16。** darktable の 6 はマニュアルでバンディング警告が出ている。
4. **H/S 用途ではピラミッドを最上位まで構築する。** 打ち切ると shadow lift が解像度依存になる（hanika）。Clarity 単独なら打ち切り可。
5. **highlights / shadows / clarity は 1 本の remap カーブに載せて 1 パスで処理**（E7 で検証）。性能上も大きな利点。
6. **フル解像度への転送は BGU 方式の bilateral-grid slicing**（[google/bgu](https://github.com/google/bgu), Apache-2.0）。WebGPU のテクスチャ/バッファ上限も同時に回避。
7. **ピラミッドは `rgba16float`、差分は f32、log2 輝度空間で。**
8. **トーンカーブは色相保存 max/mid/min 方式**（dng_sdk `RefBaselineRGBTone`）。per-channel にしない。
9. **LLF の前に chroma denoise** を通す（RAW ではノイズを構造化アーティファクトに増幅する）。
10. **guided filter を主役にしない。** 特に大 r × ε≈0.075 は halo 最悪と定量評価された設定そのもの。安価な代替が要るなら **unnormalized bilateral filter**（Aubry 2014 §2.2）の方が筋が良い。
11. **解像度非依存な半径**: darktable の `blending` に倣い、**画像長辺のパーセント**で指定する（ピクセルではなく）。
12. **EIGF の露出不変化アイデアを取り入れる**: guided filter を補助的に使う場面では、生の variance ではなく `variance / pixel_value²` を使い、**a, b の最終ボックス平均を省く**。標準 GF への 3 行の変更で「シャドウだけ過剰にぼける」非対称が消える。公開文書化された導出なので独立再導出が可能（コード転写ではなく）。
13. **§2.1 機構 B（シーン統計によるレンジ自動伸縮）の予算を取る。** ヒストグラム広がり／DR 推定が σr またはスライダー→強度写像を駆動する項。**OSS にこれを持つ実装は無い。** RT の DRC の「パノラマで破綻する」警告は、この層を実装したときに必ず出る副作用の予告です。

---

# 5. 識別実験の設計（E1–E8）

## 5.0 測定の前提条件（これを外すと全部無駄になります）

1. ★ **合成 Linear DNG を作る。** 通常の RAW を使うと demosaic / highlight recovery / CA 補正 / レンズ補正が入力を汚します。1 画素 1 サンプルの **LinearRaw DNG**（demosaic 済み）を自前で書き、`BaselineExposure = 0`、線形 `ProfileToneCurve`、`DefaultBlackRender = None` を設定。
2. **書き出しは 16bit ProPhoto TIFF**（8bit 量子化と色域クリップを避ける）。出力シャープニング・リサイズ off。
3. **他スライダーは全て 0**、プロファイル固定（可能なら線形カーブの DCP）、`crs:ProcessVersion` を固定。
4. 操作する XMP タグ: `crs:Highlights2012` / `crs:Shadows2012`（対照実験で `Exposure2012`, `Contrast2012`, `Whites2012`, `Blacks2012`, `Clarity2012`）。
5. 各実験は**同一画像内に複数条件を並べる版**と**1 条件 1 画像に分ける版**の両方を撮る。前者は安いが条件間の相互作用（＝まさに測りたい局所性）が混入するため、必ず後者で検証する。
6. 予測される「LLF らしさ」の教科書的シグネチャ: (a) **平坦パッチが勾配になる**（Fstoppers の観察）、(b) **halo が出ない**、(c) **完全に暗い画像は明るくならない**（darktable マニュアル: "only dark objects in front of bright objects are affected"）。

---

## E1 — 局所性の存在証明（同一パッチ・異背景）

**目的**: 「同じ入力値が周囲によって異なる出力になる」ことの直接証明。**この実験の公開された前例は存在しません。**

- **画像**: 18% グレーの固定サイズパッチ（64px）を、それぞれ異なる均一背景（**0.5% / 2% / 8% / 18% / 50% / 90%**）の広い場（1024px 四方）の中央に置いた 6 枚。パッチの位置・サイズは全枚で同一。
- **測定**: `Shadows = +100` の前後でのパッチ中心の出力値。背景輝度に対してプロット。
- **判定**:
  - 出力が背景によって変化 → **局所適応を確定**。変化のカーブが LLF の参照値 g 依存性そのもの。
  - 変化なし → グローバル（測定手順の誤りを疑う）。
- **追加の情報量**: 背景輝度 vs パッチ出力のカーブは、**Silverbox の remap 関数を直接フィッティングする教師データ**になります。
- **予測**: LLF なら、背景が暗いほどパッチは「明部として扱われ」持ち上がりが抑制される（あるいはその逆）方向に単調変化するはず。完全均一背景 = 0% の極限では効果が消えることも確認（"a completely dark image cannot be brightened"）。

---

## E2 — 適応の空間スケール（マルチスケール vs 単一半径）

**目的**: 「ぼかしたマスク 1 枚」なのか「ピラミッド」なのかを分ける。

- **画像**: 明暗バー（18% / 1.8%）の矩形波。周期を **4, 8, 16, 32, 64, 128, 256, 512, 1024 px** と 8 オクターブ振る。1 周期 1 画像。
- **測定**: `Shadows = +100` での「暗バー中心の持ち上がり量」を周期に対してプロット（および Michelson コントラストの変化）。
- **判定**:
  - **単一のコーナー周波数で立ち上がって飽和** → 単一半径のぼかしマスク（Photoshop / darktable shadhi / RT S/H 型）。半径がそのまま読める。
  - **log 周期軸上でなだらかに、複数オクターブにわたって単調増加** → **ピラミッド（LLF）**。
- ★ **決定的な追加条件**: 同じ内容を **1000px と 4000px** の 2 解像度で用意して繰り返す。
  - 遷移周期が**画像サイズに比例** → ピラミッドを最上位まで構築（＝ LLF、解像度非依存な「画像割合」で効く）。
  - 遷移周期が**ピクセル単位で一定** → 固定半径、またはピラミッドを打ち切っている。
  - これは hanika の警告（"stop after three levels → shadow lifting would depend on the scale of the image"）を直接検証します。**Silverbox が preview と export を一致させるために必ず知っておくべき値。**

---

## E3 — ぼかし輝度 vs 多スケール分解（2 スケール合成）

**目的**: 「粗い成分だけを動かして細部を保つ」のか「細部ごと乗算的に引きずる」のか。

- **画像**: 低周波の正弦波（周期 512px、振幅 ±2 stops）に高周波テクスチャ（周期 8px、振幅 ±0.1 stop）を重畳。低周波の位相・高周波の振幅を数段階振る。加えて「暗い広域の中の明るい細部」「明るい広域の中の暗い細部」の非対称ペア。
- **測定**: 出力の高周波成分の振幅を、**出力の低周波レベル**の関数としてプロット（入力の低周波レベルではなく）。
- **判定**:
  - 単一マスク方式 → 低周波を持ち上げると高周波の**絶対振幅も比例して**増える（＝ゲイン乗算）。
  - LLF（α ≈ 1, β < 1）→ **低周波は圧縮されるのに高周波の絶対振幅はほぼ保たれる**（＝相対コントラストが上がる）。これが「global contrast を下げつつ local contrast を保つ」の実体（Eric Chan の記述と一致）。
  - 高周波が**減衰**する → α > 1 が混ざっている（Silverbox では避けたい）。
- **副産物**: α の校正値が得られます。

---

## E4 — 強エッジでのハロー挙動 & σr の推定

**目的**: halo の有無と、detail/edge を分ける閾値 σr の実測。**Silverbox の最重要パラメータが直接出ます。**

- **画像**: 画面を縦に二分する単一ステップエッジ。3 軸で振る:
  - **コントラスト**: 1:2, 1:4, 1:8, 1:32, 1:128, 1:1000（= 1〜10 stops）
  - **エッジの鋭さ**: hard、および σ = 1, 4, 16, 64 px のガウシアンぼかし
  - **絶対輝度**: 同じ**比**コントラストのエッジを、1% / 5% / 20% / 60% を中心に配置
- **測定**: エッジ直交方向の輝度プロファイル。オーバーシュート／アンダーシュートのピーク偏差と影響幅。
- **判定**:
  - ガウシアンマスク型 → **明確な halo、幅 ≈ ぼかし半径**
  - guided filter（大 r・大 ε）→ 幅 r の halo（arXiv:1808.09411 が最悪と判定した挙動）
  - bilateral → 緩いエッジで **gradient reversal**
  - **LLF → halo なし。代わりに「平坦だったステップが単調な勾配になる」**（Fstoppers のステップウェッジ観察と一致）
- ★ **σr の推定**: エッジコントラストを掃引すると、**「detail として増幅される」→「edge として圧縮される」の切り替わり点**が現れます。log 領域なら **1.3 stops 付近**（論文既定 σr = ln 2.5）に出るはず。**この切り替わり点そのものが Silverbox の σr の校正値。**

---

## E5 — 作用空間（linear / log / エンコード済み）

**目的**: どの空間でオペレータが動いているか。ここを外すと全体が合いません。

- **方法 A（露出不変性テスト）**: 同一画像に対し
  1. `Shadows = +50` 単独
  2. `Exposure2012 = +1.0` → `Shadows = +50` → 書き出し後に数値で 1/2 倍（−1 EV 相当を逆補正）

  を比較。
  - ①② が一致 → **log（比）領域**。σr は EV 単位。
  - ② で暗部の効きが変わる → **linear または絶対値ベース**。
  - ★ これは darktable の EIGF ドキュメントが述べる「guided filter は露出依存」（*"increase exposure by 1EV → guided filtering → decrease by 1EV is NOT equivalent"*）の裏返しのテストです。
- **方法 B（E4 の再解釈）**: E4 で絶対輝度を振ったエッジ群を使い、切り替わり点が
  - **一定の比（EV 差）** で起きる → log / 相対領域
  - **一定の絶対差** で起きる → linear または encoded-absolute 領域
- **方法 C（適用位置）**: プロファイルを Adobe Standard vs 線形トーンカーブ DCP で切り替えて E4 を再走。挙動が変わらなければプロファイル**より前**（scene-referred）で効いている。
- **参考値**: darktable local contrast は **Lab の L**（display-referred）、Paris の論文は **自然対数の輝度**（scene-referred）、vkdt は **XYZ の Y**、RT S/H は **RGB（既定）または Lab**。**実装ごとに全部違うので、LR がどれかは実測でしか分かりません。**

---

## E6 — スライダーの自動レンジ伸縮（グローバルヒストグラム依存層）

**目的**: Eric Chan の *"automatically expand/reduce their effective range"* を検証・定量化。**これは LLF 本体とは別の第二の層**で、実装スコープの判断に直結します。

- **画像**: 測定対象の局所構造（E1 のパッチ + 背景、画像中央 512px 四方）を**完全に同一**にしたまま、**遠く離れた場所（画像の四隅、対象から画像幅の 1/4 以上離す）**のコンテンツだけを変える 3 枚:
  - (a) フルレンジ: 隅にほぼ黒（0.1%）とほぼ白（95%）のパッチ
  - (b) 低コントラスト（霧）: 全体が 1 stop 以内
  - (c) 高コントラスト（HDR 的）: 隅に 12 stops の差
- **測定**: `Shadows = +50` での中央パッチ出力。
- **判定**:
  - 3 枚で出力が**異なる** → **局所オペレータ × グローバルなシーン統計**の 2 層構造を確定。差分の大きさが「レンジ倍率」の校正値。**別コードパスとして実装が必要。**
  - 3 枚で**同一** → 適応は純粋に局所。実装が 1 層で済む（朗報）。
- **補助**: 同じ設計で `Contrast2012` も測る（Martin Evening の「low key / high key で動作中点が移動する」の検証）。
- **注意**: この層を実装すると RT の DRC と同じ副作用（パノラマの分割画像で明るさが飛ぶ）が出ます。Silverbox の UI/バッチ処理でどう扱うかを併せて設計してください。

---

## E7 — Highlights と Shadows は 1 つのオペレータか 2 パスか

**目的**: 単一の両側 remap カーブ（darktable の `curve_scalar` 型）なのか、独立した 2 パス（RT の型）なのか。

- **画像**: 16 段のグレーステップウェッジ（各段は十分大きい平坦パッチ）＋ E1 型のパッチ。
- **測定**: 3 通りの書き出しを比較
  1. `Highlights = −50` 単独
  2. `Shadows = +50` 単独
  3. `Highlights = −50, Shadows = +50` 同時
- **判定**:
  - ③ ≈ ① ∘ ②（合成可能）→ **独立した 2 パス**。実装は素直（RT 型）。
  - ③ ≠ ① ∘ ②（合成不能）→ **単一の LLF に両側 remap カーブを載せている**（darktable / vkdt 型）。LLF の構造からしても自然。
    → Silverbox も **1 回のピラミッド処理で highlights / shadows / clarity を同時に扱う**設計にすべき。性能上も大きな利点。
- **補助**: 同じウェッジで Tone Curve パネルの Highlights/Shadows も測り、「グローバルカーブとの差分」を可視化。Eric Chan の「Tone Curve 側は fixed range・global」の記述と照合。Fstoppers の観察（Curves では勾配が生じない）を自分の harness で再現できることの確認にもなります。

---

## E8 — 解像度／クロップ不変性（preview ↔ export 一貫性）

**目的**: Silverbox が「プレビューとエクスポートを一致させる」ために満たすべき不変量を LR から読み取る。

- **手順 A（解像度）**: 同一ファイル・同一設定で、フル解像度 / 1/2 / 1/4 / 1/8 に LR 側でリサイズ書き出し。小さい方をアップサンプルしてフル解像度と比較（低周波成分のみで比較）。
  - **一致** → パラメータが**画像相対単位**で定義され、ピラミッドは最上位まで構築（LLF、Paris の *"faithful low-resolution previews"*）。→ Silverbox も同じ不変量を満たす設計にすればプレビュー/エクスポート差が消える。
  - **系統的にずれる** → 半径がピクセル単位。→ プレビュー用に半径をスケールする補正が必要。
- **手順 B（クロップ）**: フルフレーム vs 中央 50% クロップ（LR のクロップツール）を同一設定で書き出し、共通領域の同一被写体の持ち上がり量を比較。
  - **変わる** → オペレータが画像全体を見ている（E6 のグローバル層、またはピラミッド深度がフレームサイズに連動）。
  - **変わらない** → 純粋に局所・近傍のみ。
- ★ この 2 つは Silverbox の**アーキテクチャ選択（低解像度で回して slicing するか、フル解像度で回すか）を直接決定**します。

---

## 実験の優先順位（コスパ順）

| 順位 | 実験 | 理由 |
|---|---|---|
| 1 | **E1** | 局所性の確定。10 分で決着。公開前例なし＝独自価値 |
| 2 | **E4** | σr の実測 + halo 挙動。最重要パラメータ |
| 3 | **E2** | マルチスケール性 + 解像度依存性 |
| 4 | **E5** | 作用空間。ここを外すと全部合わない |
| 5 | **E6** | グローバル層の有無。実装スコープを決める |
| 6 | **E8** | プレビュー一貫性の不変量 |
| 7 | **E7** | 1 オペレータか 2 パスか |
| 8 | **E3** | detail/base の挙動、α の校正 |

---

# 6. 未解決 / 追跡推奨

1. ⚠️ **helpx.adobe.com が本調査環境から到達不能**（curl / WebFetch / 複数ロケールで 403・タイムアウト）。Eric Chan の "local adaptation" 記述の**確定一次 URL**は [Tone Control Adjustment in Lightroom Classic and Adobe Camera Raw](https://helpx.adobe.com/lightroom-classic/help/tone-control-adjustment.html) と思われるが、逐語の裏は現状 The Phoblographer 経由。**ブラウザでの直接確認を推奨。**
2. **DPReview Retouching Forum の Eric Chan 投稿** [thread/4223483](https://www.dpreview.com/forums/thread/4223483) — 自動取得 403。ブラウザなら "improved highlight rendering logic and image-adaptive logic" の一人称発言が逐語で取れる可能性。ユーザ名 madmanchan / MadManChan2000。（madmanchan.com は写真ポートフォリオのみで技術文書なし、確認済み）
3. **Martin Evening, *Adobe Photoshop CC for Photographers* p.451** — ±50% を超えると *"applied via a **halo mask** (similar to the method used in HDR tone mapping)"* という記述がフォーラムで引用されている。**第三者による最も具体的な技術記述の可能性**。O'Reilly 版は 403。
4. **周囲依存性の実測データ** — 公開された前例なし。E1〜E8 の結果はそれ自体が公開価値を持つ。
5. **vkdt `llap` のファイル単位ライセンス確認** — BSD-2 と GPL の境界を精査してから読むこと。
6. **Bart Wronski の [WebGL exposure-fusion デモ](https://bartwronski.github.io/local_tonemapping_js_demo/)** — ブラウザで動く halo-free ローカルトーンの数少ない実例だが、リポジトリに LICENSE ファイルがなく（ブログ本文に "public domain" 記述のみ）、流用には本人確認が必要。
7. **Aurélien Pierre の tone equalizer / EIGF の論文・プレプリントは存在しない**（確認済み）。設計文書はソース内コメント、PR #1904 / #6444、pixls.us スレッドのみ。

---

# 7. 総括：2 つの設計ルートと選択

OSS コーパスに存在する実行可能なアーキテクチャは正確に 2 つで、それらは別物です。

**(a) マスク変調型 1-D カーブ** — RawTherapee 5.5+ S/H が最もクリーンな見本（4 次階調窓マスク → guided filter → ガンマ LUT → ブレンド）。安価・予測可能・LR スライダー位置への校正が容易。ART が採用した darktable tone equalizer も同族（マスク平滑化 + EV ゾーン等化）。**GPL 圏はここに収斂している。**

**(b) Local Laplacian ピラミッド** — darktable `local contrast`（LL モード）と **vkdt `llap`**。計算量は大きいが、**Adobe 自身が PV2012 についてクレジットしたのはこちら。**

**Silverbox は (b) を採るべきです。** 理由:
- Adobe の一次情報が (b) を指している
- 定量比較で LLF だけが全アーティファクト試験を通過している
- **permissive ライセンスの参照実装が (b) にだけ揃っている**（MIT の MATLAB / MIT の Halide / BSD-2 の GLSL）— 皮肉にも、GPL 圏が (a) に収斂した結果、(b) の方が MIT プロジェクトには実装しやすい
- LLF は低解像度プレビューが忠実という、Silverbox の preview/export 問題に直結する性質を持つ

**ただし (b) だけでは LR に一致しません。** Eric Chan の言う機構 B（シーン統計によるレンジ自動伸縮）は OSS のどこにも実装例がなく、**公開された数値も一切存在しません**（radius も curve もパラメータ表も、コミュニティの誰も測っていない）。**E1〜E8 の校正セッションが唯一の入手経路であり、我々は「存在するのに見つけられていない文書」を探しているのではありません。**
