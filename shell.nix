let
  nixpkgs = fetchTarball "https://github.com/NixOS/nixpkgs/archive/e6cfe7821dc7ebf4e68014de11508d7aeb566fdc.tar.gz";

  pkgs = import nixpkgs { config = {}; overlays = []; };
in


pkgs.mkShellNoCC {
  packages = with pkgs; [
    # Tools
    typescript-language-server
    nodePackages.prettier

    # Programming Languages
    nodejs_22
    pnpm
  ];
}
