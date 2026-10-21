# Changelog

## [0.5.0](https://github.com/abinnovision/tallyrelease/compare/core-v0.4.1...core-v0.5.0) (2026-10-21)


### Features

* generate docs from the config schema and typed error code registries ([#82](https://github.com/abinnovision/tallyrelease/issues/82)) ([9ee6b60](https://github.com/abinnovision/tallyrelease/commit/9ee6b6048cefaf74c9bd63403ab2db3badbc8b11))


### Bug Fixes

* **core:** import the testing fakes without vitest ([#76](https://github.com/abinnovision/tallyrelease/issues/76)) ([91c69dc](https://github.com/abinnovision/tallyrelease/commit/91c69dc36c5cb4fbd47cec360559450893842d52))

## [0.4.1](https://github.com/abinnovision/tallyrelease/compare/core-v0.4.0...core-v0.4.1) (2026-10-17)


### Miscellaneous Chores

* **core:** Synchronize tallyrelease versions

## [0.4.0](https://github.com/abinnovision/tallyrelease/compare/core-v0.3.2...core-v0.4.0) (2026-10-17)


### Features

* add a forge object to released entries ([#60](https://github.com/abinnovision/tallyrelease/issues/60)) ([7647a2d](https://github.com/abinnovision/tallyrelease/commit/7647a2d2d018a4fc2a8d09417491f80866f8b8ea))
* **cli:** suggest a maintenance branch in major release PRs ([#55](https://github.com/abinnovision/tallyrelease/issues/55)) ([bc13891](https://github.com/abinnovision/tallyrelease/commit/bc138913fd6db49c25ff0871d0506a62fc0521ac))
* **core:** accept glob keys in unit overlays ([#61](https://github.com/abinnovision/tallyrelease/issues/61)) ([32c19b4](https://github.com/abinnovision/tallyrelease/commit/32c19b4258d9b6eed098bb9709fd9879542b9c3a))
* **core:** keep releases at HEAD in the build set ([#62](https://github.com/abinnovision/tallyrelease/issues/62)) ([2e4c1ea](https://github.com/abinnovision/tallyrelease/commit/2e4c1ea81b3885c75a057a22765aae26c07ba302))
* list propagated changes on release entries and drop deprecated fields ([#66](https://github.com/abinnovision/tallyrelease/issues/66)) ([df5ead8](https://github.com/abinnovision/tallyrelease/commit/df5ead84d5be8def8601d037f80d8b65edca443c))
* mark the latest release of each unit ([#63](https://github.com/abinnovision/tallyrelease/issues/63)) ([3b7a7cb](https://github.com/abinnovision/tallyrelease/commit/3b7a7cb4b0f51568d909acad0e6c209b79575713))

## [0.3.2](https://github.com/abinnovision/tallyrelease/compare/core-v0.3.1...core-v0.3.2) (2026-10-16)


### Miscellaneous Chores

* **core:** Synchronize tallyrelease versions

## [0.3.1](https://github.com/abinnovision/tallyrelease/compare/core-v0.3.0...core-v0.3.1) (2026-10-16)


### Bug Fixes

* **core:** count prereleases from a unit's introduction without a line base ([#48](https://github.com/abinnovision/tallyrelease/issues/48)) ([06a591b](https://github.com/abinnovision/tallyrelease/commit/06a591b3522cf60ce5bde56e393f464617ffa101))

## [0.3.0](https://github.com/abinnovision/tallyrelease/compare/core-v0.2.0...core-v0.3.0) (2026-10-16)


### Features

* **cli:** add tallyrelease pr for shared and separate release PRs ([#34](https://github.com/abinnovision/tallyrelease/issues/34)) ([5dbb294](https://github.com/abinnovision/tallyrelease/commit/5dbb2944a6f9535511710cbcfa5c6ddfccb14fe8))
* **cli:** add tallyrelease run and fill released in plans ([#36](https://github.com/abinnovision/tallyrelease/issues/36)) ([8d90546](https://github.com/abinnovision/tallyrelease/commit/8d905469ed398a6daaa0e09f4fd9eb9c4c79c818))
* **core:** add changelog writer, release items and PR marker ([#30](https://github.com/abinnovision/tallyrelease/issues/30)) ([e74244e](https://github.com/abinnovision/tallyrelease/commit/e74244ebc4752e3de39614159ef0761f1cd2a33c))
* tag merged release PRs with tallyrelease release ([#35](https://github.com/abinnovision/tallyrelease/issues/35)) ([0058045](https://github.com/abinnovision/tallyrelease/commit/005804542b3f0b18a1a5afdb1a559231f8d10b4d))
* write version files and changelogs with tallyrelease version ([#33](https://github.com/abinnovision/tallyrelease/issues/33)) ([5961ce0](https://github.com/abinnovision/tallyrelease/commit/5961ce0c56b7ddbb4bff2cf154d5b5556212e8cb))

## [0.2.0](https://github.com/abinnovision/tallyrelease/compare/core-v0.1.1...core-v0.2.0) (2026-10-15)


### Features

* add fixed groups ([#23](https://github.com/abinnovision/tallyrelease/issues/23)) ([9822ded](https://github.com/abinnovision/tallyrelease/commit/9822dedcb572b852348e7df3577d101bf4d70e62))
* **cli:** add plan and explain commands ([#20](https://github.com/abinnovision/tallyrelease/issues/20)) ([4a68ff1](https://github.com/abinnovision/tallyrelease/commit/4a68ff10092b44fb994fd62f86a51b7af4bdbd5f))
* **core:** absorb internal changes as patch by default ([#22](https://github.com/abinnovision/tallyrelease/issues/22)) ([947b85f](https://github.com/abinnovision/tallyrelease/commit/947b85fd442ca650f0a47ee2349ffe41b9ea5b69))
* **core:** absorb unreleased dependencies and propagate releases ([#19](https://github.com/abinnovision/tallyrelease/issues/19)) ([bb987ba](https://github.com/abinnovision/tallyrelease/commit/bb987ba04fec52cea611cd0b8c9ed2e851fb0c9c))
* **core:** add semver scheme and conventional commit parser ([#16](https://github.com/abinnovision/tallyrelease/issues/16)) ([2012c0b](https://github.com/abinnovision/tallyrelease/commit/2012c0ba035d551335f14ba709ec6db5d5ea1582))
* **core:** compute release versions with computePlan ([#18](https://github.com/abinnovision/tallyrelease/issues/18)) ([0341c3e](https://github.com/abinnovision/tallyrelease/commit/0341c3eea127abf32c1eda59344481a3ee506e84))
* **core:** match unit tags and collect plan facts ([#17](https://github.com/abinnovision/tallyrelease/issues/17)) ([828f9bd](https://github.com/abinnovision/tallyrelease/commit/828f9bd427b6e69419bdbb00d6570edee0cd9e0e))
* enforce maintenance branch limits ([#24](https://github.com/abinnovision/tallyrelease/issues/24)) ([c5e382b](https://github.com/abinnovision/tallyrelease/commit/c5e382bb1d58430555b85d8076659272353c1e30))

## [0.1.1](https://github.com/abinnovision/tallyrelease/compare/core-v0.1.0...core-v0.1.1) (2026-10-15)


### Bug Fixes

* add unit tags and an affected --tag filter ([#14](https://github.com/abinnovision/tallyrelease/issues/14)) ([733e556](https://github.com/abinnovision/tallyrelease/commit/733e55642dc582e24e06d2e2b118110547ace742))

## 0.1.0 (2026-10-15)


### Features

* bootstrap tallyrelease with build selection (v0.1) ([#1](https://github.com/abinnovision/tallyrelease/issues/1)) ([4efde72](https://github.com/abinnovision/tallyrelease/commit/4efde72e32091df3c84a2b497272a3a0efdac659))
* **cli:** align human-readable output and add a local build base ([#8](https://github.com/abinnovision/tallyrelease/issues/8)) ([96cb5f0](https://github.com/abinnovision/tallyrelease/commit/96cb5f010f3090806da4317a50c23ba17884c5c5))
* make units build-only unless opted into release ([#6](https://github.com/abinnovision/tallyrelease/issues/6)) ([4b01768](https://github.com/abinnovision/tallyrelease/commit/4b0176809d38504eec22e35168f57ca17840ef13))


### Bug Fixes

* **cli:** clearer errors and package docs for the 0.1.0 release ([#11](https://github.com/abinnovision/tallyrelease/issues/11)) ([85fc7ed](https://github.com/abinnovision/tallyrelease/commit/85fc7ed70693bae01c9b90319d808f72f5eef6f6))
