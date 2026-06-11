let
  nixpkgs = fetchTarball "https://github.com/NixOS/nixpkgs/archive/8c50a710ddca43d7a530fb805ad55bde8d0141c5.tar.gz";

  pkgs = import nixpkgs { config = {}; overlays = []; };
in


pkgs.mkShellNoCC {
  packages = with pkgs; [
    # Tools
    typescript-language-server

    # Programming Languages
    nodejs_22
    pnpm
  ];
}
